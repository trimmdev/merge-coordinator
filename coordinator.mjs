#!/usr/bin/env node
// merge-coordinator — a 24/7 cloud coordinator that lands your pull requests.
//
// Workers open PRs; the coordinator owns landing them. It:
//   • arms every eligible PR so GitHub merges it the moment its checks pass,
//   • keeps "serial" lanes (paths you mark risky-to-combine) to ONE PR at a time,
//   • re-validates a stale PR against the current base before it merges,
//   • re-arms the instant GitHub silently disables auto-merge,
//   • optionally auto-opens + arms a revert PR when a chosen post-merge workflow fails,
//   • never bypasses your required checks / branch protection.
//
// It is NOT a batch-integration queue: cheap PRs already land independently through
// your normal checks, and "serial" PRs must not be blind-batched. This automates the
// arming discipline instead.
//
// Modes:  status | sweep | arm <n> | hold <n> | unhold <n> | revert-check
//         (default: sweep).  Add --dry to force no-mutations. --quiet suppresses Discord.
//
// Auth: uses whatever `gh` is authenticated as. In CI set GH_TOKEN to a token whose
// writes RE-TRIGGER your workflows (a PAT or App token) — the default GITHUB_TOKEN
// does NOT, so a branch update / revert PR it makes would never re-run your gate.
// Zero dependencies. Node 18+.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── config ───────────────────────────────────────────────────────────────────
function loadConfig() {
  let cfg = {};
  for (const f of ['merge-coordinator.config.json', '.github/merge-coordinator.config.json']) {
    try { cfg = JSON.parse(readFileSync(f, 'utf8')); break; } catch {}
  }
  return {
    repo: process.env.COORD_REPO || cfg.repo || process.env.GITHUB_REPOSITORY || '',
    base: cfg.base || 'main',
    mergeMethod: cfg.mergeMethod || 'rebase',           // rebase | squash | merge
    requiredCheck: cfg.requiredCheck || '',             // '' = use overall check rollup
    checkWorkflow: cfg.checkWorkflow || '',             // e.g. 'ci.yml' → read gate via Actions API (fine-grained-token safe)
    holdLabel: cfg.holdLabel || 'hold',
    lanes: cfg.lanes || [],                             // [{name, match:[globs], serialize, revalidate}]
    revertOn: cfg.revertOn || null,                     // {workflow, jobs:[...]} or null
  };
}
const CFG = loadConfig();
const REPO = CFG.repo;
const BASE = CFG.base;
const HOLD = CFG.holdLabel;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const QUIET = process.argv.includes('--quiet') || process.env.COORD_QUIET === '1';
if (!REPO) { console.error('merge-coordinator: no repo. Set `repo` in merge-coordinator.config.json, or COORD_REPO / GITHUB_REPOSITORY.'); process.exit(2); }

// ── tiny glob matcher (no deps): ** → across slashes, * → within a segment ─────
function globToRe(g) {
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}
const LANES = CFG.lanes.map(l => ({ ...l, res: (l.match || []).map(globToRe) }));

// ── gh helpers (execFile: no shell, so complex args pass verbatim) ─────────────
function gh(args, { allowFail = false } = {}) {
  try { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch (e) {
    if (allowFail) return { __err: (e.stderr || e.message || '').toString().trim() };
    throw new Error(`gh ${args.join(' ')}\n${(e.stderr || e.message || '').toString()}`);
  }
}
const ghJson = (a, o) => { const r = gh(a, o); return typeof r === 'string' ? JSON.parse(r || 'null') : r; };
const failed = r => r && typeof r === 'object' && '__err' in r;

const out = [];
function log(s) { out.push(s); console.log(s); }
async function ping(msg) {
  log(msg);
  if (!WEBHOOK || QUIET) return;
  try {
    await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg.slice(0, 1900) }) });
  } catch (e) { log(`(discord ping failed: ${e.message})`); }
}

// ── classification ─────────────────────────────────────────────────────────
function classify(files) {
  let serialize = false, revalidate = false;
  for (const lane of LANES) {
    if (files.some(f => lane.res.some(re => re.test(f)))) {
      if (lane.serialize) serialize = true;
      if (lane.revalidate) revalidate = true;
    }
  }
  return { serialize, revalidate, lane: serialize ? 'SERIAL' : 'PARALLEL' };
}

// ── queue + per-PR facts ─────────────────────────────────────────────────────
function queue() {
  const F = 'number,title,isDraft,mergeable,mergeStateStatus,autoMergeRequest,labels,headRefName,headRefOid,author,createdAt,updatedAt';
  const useActions = !!CFG.checkWorkflow;
  let prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--base', BASE, '--limit', '100', '--json', useActions ? F : F + ',statusCheckRollup'], { allowFail: true });
  let checksOk = true;
  if (failed(prs)) {
    checksOk = false;
    log('⚠️  could not read check status via statusCheckRollup — a fine-grained token can\'t read check runs. Set `checkWorkflow` in the config to read the gate via the Actions API instead. Treating checks as unknown; will NOT arm until fixed.');
    prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--base', BASE, '--limit', '100', '--json', F]) || [];
  }
  return (prs || []).map(p => {
    const files = prFiles(p.number);                 // null = fetch failed (don't guess the lane)
    return { ...p, files, filesUnknown: files === null, ...classify(files || []),
      labels: (p.labels || []).map(l => l.name),
      armed: !!p.autoMergeRequest,
      conflicting: p.mergeStateStatus === 'DIRTY' || p.mergeable === 'CONFLICTING',
      checks: useActions ? gateState(p.headRefOid) : (checksOk ? rollup(p.statusCheckRollup) : 'unknown') };
  });
}
// Read the gate via the Actions API (the CI workflow's run conclusion for this SHA).
// Works with a fine-grained token's "Actions: read" — fine-grained tokens CANNOT read
// check runs (there is no "Checks" permission to grant), so statusCheckRollup fails for
// them. Set `checkWorkflow` in the config to the workflow file whose conclusion is your gate.
function gateState(sha) {
  if (!sha) return 'pending';
  const r = gh(['api', `repos/${REPO}/actions/workflows/${CFG.checkWorkflow}/runs?head_sha=${sha}&per_page=1`,
    '--jq', '.workflow_runs[0] | ((.status // "none") + "|" + (.conclusion // ""))'], { allowFail: true });
  if (failed(r) || !r || r.startsWith('none')) return 'pending';
  const [status, concl] = r.split('|');
  if (status !== 'completed') return 'pending';
  return concl === 'success' ? 'green' : 'red';
}
// Returns the changed paths, or null if the API call failed — so a transient error
// can't silently drop a PR into the wrong lane (we skip it this sweep instead).
function prFiles(n) {
  const r = gh(['api', `repos/${REPO}/pulls/${n}/files`, '--paginate', '--jq', '.[].path'], { allowFail: true });
  return failed(r) ? null : r.split('\n').filter(Boolean);
}
function behindBy(head) {
  const r = gh(['api', `repos/${REPO}/compare/${BASE}...${head}`, '--jq', '.behind_by'], { allowFail: true });
  return failed(r) ? 0 : (parseInt(r, 10) || 0);
}
// 'red' | 'pending' | 'green'. Keys on requiredCheck if configured (only a failed
// required check makes GitHub auto-disable, and an unrelated red check must not block).
function rollup(nodes) {
  const a = nodes || [];
  const bad = s => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s);
  if (CFG.requiredCheck) {
    const g = a.find(c => (c.__typename === 'CheckRun' && c.name === CFG.requiredCheck) ||
                          (c.__typename === 'StatusContext' && c.context === CFG.requiredCheck));
    if (!g) return 'pending';
    if (bad(g.conclusion) || bad(g.state)) return 'red';
    if (g.__typename === 'CheckRun') return g.status === 'COMPLETED' ? 'green' : 'pending';
    return g.state === 'SUCCESS' ? 'green' : 'pending';
  }
  if (!a.length) return 'pending';
  let pend = false;
  for (const c of a) {
    if (bad(c.conclusion) || bad(c.state)) return 'red';
    if ((c.__typename === 'CheckRun' && c.status !== 'COMPLETED') ||
        (c.__typename === 'StatusContext' && c.state !== 'SUCCESS')) pend = true;
  }
  return pend ? 'pending' : 'green';
}

// ── actions (idempotent) ─────────────────────────────────────────────────────
function arm(pr, dry) {
  if (pr.armed) return 'already armed';
  if (dry) return 'WOULD arm';
  const r = gh(['pr', 'merge', String(pr.number), '--repo', REPO, '--auto', '--' + CFG.mergeMethod], { allowFail: true });
  return failed(r) ? `arm FAILED: ${r.__err.split('\n')[0]}` : 'ARMED';
}
function disarm(pr, dry) {
  if (!pr.armed) return 'not armed';
  if (dry) return 'WOULD disarm';
  const r = gh(['pr', 'merge', String(pr.number), '--repo', REPO, '--disable-auto'], { allowFail: true });
  return failed(r) ? `disarm FAILED: ${r.__err.split('\n')[0]}` : 'DISARMED';
}
function updateBranch(pr, dry) {
  if (dry) return 'WOULD update-branch';
  const r = gh(['api', '--method', 'PUT', `repos/${REPO}/pulls/${pr.number}/update-branch`], { allowFail: true });
  if (failed(r)) return /already up to date|not ahead/i.test(r.__err) ? 'up to date' : `update-branch FAILED: ${r.__err.split('\n')[0]}`;
  return 'UPDATED-BRANCH (checks re-run vs current base)';
}
function setHold(pr, on, dry) {
  if (dry) return on ? 'WOULD hold' : 'WOULD unhold';
  gh(['pr', 'edit', String(pr.number), '--repo', REPO, on ? '--add-label' : '--remove-label', HOLD], { allowFail: true });
  return on ? 'HELD' : 'UNHELD';
}
function eligible(pr) {
  if (pr.filesUnknown) return 'files-unknown';   // couldn't read the diff → skip, retry next sweep
  if (pr.checks === 'unknown') return 'checks-unknown'; // couldn't read checks → don't risk arming
  if (pr.isDraft) return 'draft';
  if (pr.labels.includes(HOLD)) return 'hold';
  if (pr.conflicting) return 'needs-rebase';
  if (pr.checks === 'red') return 'checks-red';
  return null;
}
const byAge = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

// ── sweep ────────────────────────────────────────────────────────────────────
async function sweep(dry) {
  const prs = queue();
  const acts = [];
  const rec = (pr, m) => { if (m && !/already|not armed|up to date/.test(m)) acts.push({ pr, m }); };

  const serial = prs.filter(p => p.serialize);
  const parallel = prs.filter(p => !p.serialize);

  for (const pr of parallel) {
    if (eligible(pr)) continue;
    rec(pr, arm(pr, dry));
    if (pr.revalidate && behindBy(pr.headRefName) > 0) rec(pr, updateBranch(pr, dry));
  }

  const ready = serial.filter(p => !eligible(p));
  if (ready.length) {
    const armed = ready.filter(p => p.armed).sort(byAge);
    const leader = armed[0] || ready.slice().sort(byAge)[0];
    for (const pr of ready) if (pr.number !== leader.number && pr.armed) rec(pr, disarm(pr, dry) + ' (serial lock — one at a time)');
    rec(leader, arm(leader, dry));
    if (leader.revalidate && behindBy(leader.headRefName) > 0) rec(leader, updateBranch(leader, dry));
    const waiting = ready.filter(p => p.number !== leader.number).map(p => `#${p.number}`);
    if (waiting.length) acts.push({ note: `serial lane: #${leader.number} goes first (one at a time) — holding ${waiting.join(' ')} until it lands` });
  }

  board(prs);
  const rev = await revertCheck(dry);
  if (acts.length || rev) await ping(sweepReport(prs, acts, rev, dry));
  else log('sweep: nothing to do.');
}

async function status() {
  const prs = queue();
  board(prs);
  await ping(`📋 **merge queue** (${prs.length} open)\n${prs.map(fmt).join('\n') || '_empty_'}\n\n${LEGEND}`);
}
function board(prs) { log(`\n── ${REPO} · ${prs.length} open PR(s) → ${BASE} ──`); prs.forEach(p => log('  ' + fmt(p))); log(''); }
function fmt(p) {
  const f = [];
  if (p.isDraft) f.push('draft');
  if (p.labels.includes(HOLD)) f.push('HOLD');
  if (p.conflicting) f.push('NEEDS-REBASE');
  if (p.filesUnknown) f.push('files?');
  if (p.checks === 'red') f.push('checks-red');
  f.push(p.armed ? 'armed' : 'unarmed', `checks:${p.checks}`);
  return `#${p.number} [${p.lane}${p.serialize ? '/lock' : ''}${p.revalidate ? '/reval' : ''}] ${trunc(p.title, 46)} — ${f.join(' ')}`;
}
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ── Discord message composition (rich + self-explaining) ─────────────────────
// A ping should say WHAT changed, WHY, and whether the human must act — so every
// action carries a plain-English gloss + the live check state + a click-through
// PR link, and a footer defines the vocabulary ("what does ARMED mean?").
const GATE_ICON = { green: '🟢', pending: '🟡', red: '🔴', unknown: '⚪' };
const gateIcon = c => GATE_ICON[c] || '⚪';
const LEGEND =
  '_“ARMED” = auto-merge is enabled: the PR is queued and the platform merges it **by itself** the instant ' +
  'its required checks pass — it is **not merged yet**, and there is nothing to do. The coordinator only arms ' +
  'PRs that are already eligible (not draft/held/conflicting, checks not red); it never bypasses required ' +
  'checks or branch protection. Use `hold <#>` to park one you want to review first._';
function explainAction(m) {
  if (/^ARMED/.test(m))          return 'auto-merge is now ON — it lands by itself the moment its required checks pass; nothing to do';
  if (/^DISARMED/.test(m))       return 'auto-merge turned OFF';
  if (/^UPDATED-BRANCH/.test(m)) return 'branch was behind base — refreshed it, so checks re-run against the current base before it can land';
  if (/^HELD/.test(m))           return 'parked — it will NOT auto-merge until it is unheld';
  if (/^UNHELD/.test(m))         return 'un-parked — eligible to be armed again';
  if (/^WOULD/.test(m))          return 'dry run only — no change was made; this is what a live sweep would do';
  if (/FAILED/.test(m))          return 'the action failed — see the error; the next sweep retries';
  return '';
}
function fmtAct(a) {
  if (a.note) return `• ${a.note}`;
  const { pr, m } = a;
  const who = pr.author && pr.author.login ? ` · @${pr.author.login}` : '';
  const lane = pr.serialize ? 'serial lane (one at a time)' : 'parallel lane';
  const why = explainAction(m);
  const url = `https://github.com/${REPO}/pull/${pr.number}`;
  const head = `**#${pr.number} — ${m}** · ${trunc(pr.title, 56)}`;
  const meta = `${gateIcon(pr.checks)} checks ${pr.checks} · ${lane}${who}`;
  return `${head}\n   ${why ? why + '\n   ' : ''}${meta}\n   ${url}`;
}
function queueSnapshot(prs) {
  const armed = prs.filter(p => p.armed).length;
  const waiting = prs.filter(p => p.armed && p.checks !== 'green').length;
  const held = prs.filter(p => p.labels.includes(HOLD)).length;
  const blocked = prs.filter(p => p.checks === 'red' || p.conflicting).length;
  const bits = [`${prs.length} open`, `${armed} armed`];
  if (waiting) bits.push(`${waiting} waiting on checks`);
  if (held) bits.push(`${held} held`);
  if (blocked) bits.push(`${blocked} blocked`);
  return bits.join(' · ');
}
function sweepReport(prs, acts, rev, dry) {
  const parts = [
    `🤝 **merge-coordinator**${dry ? ' (dry run — no changes made)' : ''} · ${queueSnapshot(prs)}`,
    '',
    acts.map(fmtAct).join('\n'),
  ];
  if (rev) parts.push('', rev);
  parts.push('', LEGEND);
  return parts.join('\n');
}

async function armOne(n, dry) {
  const prs = queue(); const pr = prs.find(p => p.number === n);
  if (!pr) return ping(`arm: PR #${n} not open on ${BASE}.`);
  const why = eligible(pr);
  if (why && why !== 'checks-red') return ping(`arm #${n}: blocked — ${why}.`);
  if (pr.serialize) {
    for (const o of prs.filter(p => p.serialize && p.number !== n && p.armed)) disarm(o, dry);
    if (pr.revalidate && behindBy(pr.headRefName) > 0) updateBranch(pr, dry);
  }
  const r = arm(pr, dry);
  const gloss = explainAction(r);
  await ping(`🤝 **arm #${n}** (${pr.lane} lane) — ${r}\n   ${gloss ? gloss + '\n   ' : ''}${gateIcon(pr.checks)} checks ${pr.checks} · https://github.com/${REPO}/pull/${n}\n\n${LEGEND}`);
}
async function holdOne(n, on, dry) {
  const prs = queue(); const pr = prs.find(p => p.number === n);
  if (!pr) return ping(`${on ? 'hold' : 'unhold'}: PR #${n} not found.`);
  const h = setHold(pr, on, dry); const d = on ? disarm(pr, dry) : '';
  const note = on
    ? 'parked — it will NOT auto-merge until you `unhold` it'
    : 'un-parked — the coordinator may arm it again on the next sweep';
  await ping(`🤝 **${on ? 'hold' : 'unhold'} #${n}** — ${h}${d && d !== 'not armed' ? ' · ' + d : ''}\n   ${note}\n   https://github.com/${REPO}/pull/${n}`);
}

// ── post-merge-red → auto-revert (opt-in via config.revertOn) ────────────────
async function revertCheck(dry) {
  if (!CFG.revertOn || !CFG.revertOn.workflow) return '';
  const runs = ghJson(['run', 'list', '--repo', REPO, '--workflow', CFG.revertOn.workflow, '--branch', BASE,
    '--limit', '5', '--json', 'databaseId,headSha,conclusion,status,createdAt,url'], { allowFail: true });
  if (failed(runs) || !runs) return '';
  const done = runs.filter(r => r.status === 'completed').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!done.length || done[0].conclusion !== 'failure') return '';
  const run = done[0], sha7 = run.headSha.slice(0, 7);
  const wantJobs = CFG.revertOn.jobs || [];
  if (wantJobs.length) {
    const jl = (ghJson(['run', 'view', String(run.databaseId), '--repo', REPO, '--json', 'jobs'], { allowFail: true }) || {}).jobs || [];
    if (!jl.some(j => wantJobs.includes(j.name) && j.conclusion === 'failure'))
      return `🔴 ${CFG.revertOn.workflow} failed @ ${sha7} (not a revert-trigger job) → your call: ${run.url}`;
  }
  const open = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--search', `revert ${sha7} in:title`, '--json', 'number'], { allowFail: true });
  if (!failed(open) && open && open.length) return `🔁 revert for ${sha7} already open: #${open[0].number}`;
  if (dry) return `🔴🔁 WOULD open+arm a revert PR for ${sha7}`;
  return openRevert(run.headSha, sha7);
}
function openRevert(sha, sha7) {
  const dir = mkdtempSync(join(tmpdir(), 'coord-revert-'));
  try {
    const url = TOKEN ? `https://x-access-token:${TOKEN}@github.com/${REPO}.git` : `https://github.com/${REPO}.git`;
    const g = (a, o) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', ...o });
    execFileSync('git', ['clone', '--depth', '50', '--branch', BASE, url, dir], { encoding: 'utf8' });
    g(['config', 'user.name', 'merge-coordinator']);
    g(['config', 'user.email', 'merge-coordinator@users.noreply.github.com']);
    const br = `revert-${sha7}`;
    g(['checkout', '-b', br]);
    try { g(['revert', '--no-edit', sha]); }
    catch { g(['revert', '--abort'], { stdio: 'ignore' }); rmSync(dir, { recursive: true, force: true });
      return `🔴 ${sha7} failed but AUTO-REVERT HIT A CONFLICT — manual revert needed.`; }
    g(['push', 'origin', br]);
    const created = gh(['pr', 'create', '--repo', REPO, '--base', BASE, '--head', br,
      '--title', `Revert ${sha7} — post-merge check failed`,
      '--body', `Automated revert: \`${CFG.revertOn.workflow}\` failed on \`${sha}\`. Restores the last good ${BASE}; diagnose on a branch.\n\n🤖 opened + armed by merge-coordinator.`], { allowFail: true });
    if (failed(created)) return `🔴 ${sha7} — revert branch pushed but PR create FAILED: ${created.__err.split('\n')[0]}`;
    const num = (created.match(/\/pull\/(\d+)/) || [])[1];
    if (num) gh(['pr', 'merge', num, '--repo', REPO, '--auto', '--' + CFG.mergeMethod], { allowFail: true });
    return `🔴🔁 ${sha7} → opened + armed revert PR: ${created}`;
  } catch (e) { return `🔴 ${sha7} — auto-revert failed: ${(e.message || '').split('\n')[0]}. Manual revert needed.`; }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pos = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const mode = pos[0] || 'sweep';
  const dry = process.argv.includes('--dry') || mode === 'status';
  const n = pos[1] ? parseInt(pos[1], 10) : NaN;
  switch (mode) {
    case 'status': await status(); break;
    case 'sweep': await sweep(dry); break;
    case 'arm': await armOne(n, dry); break;
    case 'hold': await holdOne(n, true, dry); break;
    case 'unhold': await holdOne(n, false, dry); break;
    case 'revert-check': { const r = await revertCheck(dry); await (r ? ping(r) : Promise.resolve(log('revert-check: clean.'))); break; }
    default: console.error(`unknown mode "${mode}". use: status|sweep|arm <n>|hold <n>|unhold <n>|revert-check`); process.exit(2);
  }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
