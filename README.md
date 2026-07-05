# merge-coordinator

A **24/7 cloud coordinator that lands your pull requests automatically** — and safely.

Workers (people or coding agents) open PRs. The coordinator owns landing them: it arms every
eligible PR so GitHub merges it the moment its checks pass, keeps risky-to-combine changes to
**one at a time**, re-validates stale PRs before they merge, re-arms the instant GitHub silently
disables auto-merge, and can auto-revert a bad merge. It runs on **GitHub Actions**, so it works
with your machine off — and it **can never bypass your required checks or branch protection**.

It's ~1 file of zero-dependency Node driving the `gh` CLI, plus one workflow and a small config.

```
you/agent open a PR ──▶ your checks run ──▶ coordinator arms it ──▶ GitHub merges on green
```

---

## Why

When several PRs are ready at once, the manual merge dance gets slow and error-prone:

- you have to **arm** every PR (turn on auto-merge) by hand;
- GitHub **silently disables** auto-merge whenever a check hiccups, and never re-enables it — so a
  finished PR just stalls;
- a PR green'd against an **old base** can merge without re-checking against what landed since (two
  independently-fine changes can conflict or, for tightly-coupled code, jointly break something);
- if a bad change lands, the **revert** is manual and slow.

This automates all four, so opening the PR is the whole job.

## What it does

| | |
|---|---|
| **Arms everything on green** | Enables auto-merge on every eligible PR; GitHub merges each the moment its checks pass. |
| **Two lanes** | *Parallel* PRs land independently. *Serial* PRs (paths you flag) go **one at a time**. |
| **Re-validates stale PRs** | A PR behind the base gets its branch updated first, so your checks re-run against current base before it merges. |
| **Re-arms instantly** | The moment GitHub disables auto-merge, it turns it back on. |
| **Auto-revert (opt-in)** | If a chosen post-merge workflow fails, it opens + arms a revert PR. |
| **Never bypasses the gate** | It only enables auto-merge (which waits for green) and opens PRs (which run your checks). |

### Why not a merge queue or a batch-integration bot?

Native merge queues re-run your *full* required checks on every queued PR (sometimes twice), which
taxes cheap PRs that could have merged independently. Batch-integration bots bundle many PRs into
one test run — pointless when your checks already pass per-PR in minutes, and risky for
tightly-coupled changes that must not be blind-batched. This tool instead **automates the arming
discipline** you'd otherwise do by hand, and restores the "must be up to date" guarantee for **only
the PRs that need it** (your serial/revalidate lanes) — leaving cheap PRs on the fast path.

> Inspired by the framing in [jremick/agent-merge-batch-protocol](https://github.com/jremick/agent-merge-batch-protocol)
> (workers don't merge; one coordinator owns the write path) — this is a working, lane-aware
> implementation of that idea.

## Quickstart

1. **Copy three files** into your repo: `coordinator.mjs`, `.github/workflows/merge-coordinator.yml`,
   and `merge-coordinator.config.json` (start from `merge-coordinator.config.example.json`).
2. **Protect your base branch** with a required status check (this is what "green" means). The
   coordinator can never merge past it.
3. **Create a token** — a fine-grained PAT (see below) — and add it as a repo secret:
   ```bash
   gh secret set COORD_TOKEN --repo OWNER/REPO
   ```
4. **Create the opt-out label** so you can park a PR:
   ```bash
   gh label create hold --repo OWNER/REPO --color BFD4F2 --description "coordinator: do not auto-merge"
   ```
5. That's it. Open a PR — it merges itself on green. Until `COORD_TOKEN` is set, the coordinator runs
   in **dry mode** (reports what it *would* do, changes nothing).

### The token — and why it must be a PAT, not the built-in one

The coordinator's writes must **re-trigger your workflows**. GitHub deliberately suppresses workflow
events caused by the default `GITHUB_TOKEN`, so if it used that token, a branch-update or a revert PR
it created would **never re-run your checks** — a stale PR could merge un-revalidated, and a revert PR
could never satisfy a required check.

So give it a **fine-grained personal access token** (or a GitHub App token):

- **Repository access:** only the repo(s) you want it to run on.
- **Permissions:** *Contents* → Read & write · *Pull requests* → Read & write · *Workflows* →
  Read & write · *Actions* → **Read-only** · *Metadata* → Read-only (auto).

Store it as the `COORD_TOKEN` secret. It **still can't bypass your branch protection** — it can only
enable auto-merge (which waits for green) and open PRs (which run your checks).

> **Reading each PR's green/red — important for fine-grained tokens.** Fine-grained PATs **cannot
> read check runs** (GitHub exposes no "Checks" permission to grant), so the usual `statusCheckRollup`
> fails for them. Instead, set **`checkWorkflow`** in the config to your CI workflow file (e.g.
> `"ci.yml"`) — the coordinator then reads the gate from that workflow's **run conclusion** via the
> *Actions: read* permission, which fine-grained tokens *do* support. (If you use a classic PAT or a
> GitHub App token that can read checks, you can leave `checkWorkflow` empty and it uses
> `statusCheckRollup`.)

## Configuration

`merge-coordinator.config.json` (repo auto-detected in Actions via `GITHUB_REPOSITORY`):

```json
{
  "base": "main",
  "mergeMethod": "rebase",
  "requiredCheck": "",
  "holdLabel": "hold",
  "lanes": [
    { "name": "serial-core", "match": ["src/core/**", "migrations/**"], "serialize": true, "revalidate": true },
    { "name": "backend",     "match": ["server/**"],                    "serialize": false, "revalidate": true }
  ],
  "revertOn": null
}
```

| field | meaning |
|---|---|
| `base` | Branch PRs target and merge into. Default `main`. |
| `mergeMethod` | `rebase` \| `squash` \| `merge`. |
| `requiredCheck` | Name of your single required check (e.g. a `gate` job). If set, arm-eligibility keys on it alone; leave `""` to use the overall check rollup. (Only used when `checkWorkflow` is empty.) |
| `checkWorkflow` | CI workflow file (e.g. `"ci.yml"`) whose run conclusion == your gate. **Set this if you use a fine-grained token** — it reads status via *Actions: read* instead of `statusCheckRollup` (which fine-grained tokens can't read). Empty → use `statusCheckRollup`. |
| `holdLabel` | Label that parks a PR (never auto-merged). Default `hold`. |
| `lanes` | Rules matched against a PR's changed files. A PR is **serial** (one-at-a-time) if it matches any lane with `serialize:true`, and **revalidated** (branch updated when stale) if it matches any lane with `revalidate:true`. No match → parallel, no revalidation. Globs support `*` and `**`. |
| `revertOn` | `null`, or `{ "workflow": "nightly.yml", "jobs": ["e2e"] }` — if that post-merge workflow's run on the base fails (optionally only when one of `jobs` failed), open + arm a revert PR. Omit `jobs` to trigger on any failure. |

**Lanes, in plain terms:** put paths that are *risky to combine* (schema/migrations, tightly-coupled
core logic) in a `serialize:true` lane so only one lands at a time and is re-checked against current
base first. Put paths that just need up-to-date validation (backends, anything order-sensitive) in a
`revalidate:true` lane. Everything else flows in parallel.

## Driving it by hand

Any device:

- **`gh workflow run merge-coordinator.yml -f action=status`** — read-only queue board.
- **`... -f action=arm -f pr=42`** — arm a specific PR (also `hold` / `unhold` / `sweep` / `revert-check`).
- Locally: `node coordinator.mjs status` (or `sweep`, `arm 42`, `hold 42`, `revert-check`; add `--dry`).
- GitHub Mobile: view the queue, add/remove the `hold` label, trigger the workflow.

**Optional Discord pings:** set a `DISCORD_WEBHOOK_URL` secret and it posts a line on every action.

## The one thing to remember — the `hold` opt-out

"Arm everything on green" means a PR merges the moment it's green — **including one you still want to
review or test manually**. To hold a PR back: mark it a **draft**, or add the **`hold`** label. The
coordinator leaves draft / `hold` PRs completely alone. Drop the label (or mark ready) when you're
happy and it lands.

## What it will never do

- Push to your base branch, or merge past a required check / branch protection.
- Arm two PRs in a `serialize` lane at once.
- Auto-resolve a merge conflict (a conflicting PR is reported "needs a rebase — hand it back").
- Auto-revert a failure outside your configured `revertOn` (it just reports it).

## How it works (for the curious)

- Reads the open PRs with `gh pr list`, and each PR's changed files with the GitHub API — no cloning.
- Maps files to lanes with the globs in your config.
- "Stale" is detected with `compare/base...head` (`behind_by`), so it works even with branch-protection
  strictness off.
- Idempotent: every run re-derives state and only acts on what's out of place — safe to run on a cron
  and on events at once (a global concurrency group serializes runs).

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, share it.
