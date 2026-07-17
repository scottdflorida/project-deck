# Project Deck

Project Deck is a portable local dashboard for every direct folder inside a
parent directory you choose. It measures each project, detects Git and GitHub
state, compares local branches with their remotes, and puts common repository
actions in one place.

## What it shows

- Descriptions from README/ABOUT/OVERVIEW files or project manifests, with the
  exact source shown beside each description
- Total on-disk size for every project
- Git status, current branch, recent activity, and working-tree changes; slow or
  iCloud-offloaded working trees are identified without hiding known Git facts
- Git histories managed by coding agents in an external Git directory, resolved
  through Git's `core.worktree` metadata and labeled as agent-managed
- Latest Git activity from the newest local commit or GitHub push, never the
  folder modification time (copying or hydrating a folder does not look like work)
- Exact-name GitHub matches and linked `origin` repositories
- Ahead, behind, diverged, unpublished, and in-sync states
- Clickable project, size, Git, GitHub, and sync column headers, with the same
  sorting controls in a compact selector on smaller screens
- Working set, needs-attention, local-only, and ignored views
- Search and a responsive project ledger

If no useful local description is found, Project Deck says so rather than
inventing one. You can add a private local description from the project's menu.
Local descriptions are saved in Project Deck's settings and never edit project
files.

**Copy folder path** copies that project's canonical absolute path. It is kept
next to the visible path rather than presented as an unexplained project action.

Projects marked **Ignored** are hidden from normal views but remain available in
the Ignored view and can be restored. Projects without a GitHub repository can
be marked **Local only**, which keeps their local Git information visible while
suppressing GitHub publishing prompts and remote-derived attention. Neither
preference changes project files, Git remotes, or GitHub repositories. Every row
exposes **Ignore project** in its identity section. A project without a repository
offers **Keep local only**; when a repository already exists, that control is
instead labeled **Ignore GitHub sync** because the remote is not changed or made
“local only.” **Resume GitHub sync** reverses that preference.

Sync labels separate committed history from working-tree changes. **In sync**
means the local and GitHub commit histories match and the working tree is clean.
**Commits in sync** means those histories match but uncommitted local changes
still exist, so the row offers **Commit & push N changes**. A clean branch that
is behind GitHub offers **Pull N commits**. Pull is deliberately conservative:
it fetches and performs a fast-forward-only update, and refuses to run when the
working tree is dirty or the histories have diverged.

## Available actions

Actions live with the state they affect: initialization under **Git**, repository
creation/linking/opening under **GitHub**, and publishing or reconciliation
guidance under **Sync**. There is no separate catch-all action column.

- Initialize a folder as a Git repository on `main`
- Link an exact-name repository already in your GitHub account
- Create a private or public GitHub repository
- Pull remote commits with a clean, fast-forward-only update
- Stage, commit, and push local changes

Pushes stop when the remote branch is ahead or diverged. Obvious untracked
secret files such as `.env`, private keys, and credential JSON files are blocked
before staging.

When Codex, Claude, or another coding tool uses a separate Git database whose
`core.worktree` points at the selected project, Project Deck reads that history,
branch, origin, changes, and sync state. Mutating actions are deliberately routed
back to the active coding session so the dashboard cannot accidentally change a
different `.git` database inside the project folder.

## Requirements

- Node.js `>=22.13.0`
- Git
- [GitHub CLI](https://cli.github.com/) for GitHub status and actions

## First-run setup

The first time Project Deck opens, a two-step setup appears in the web app:

1. Choose the parent folder containing your projects.
2. Connect your GitHub account, or continue with local Git information only.

Project Deck checks the GitHub CLI installed on that computer. If it is not
already authenticated, **Connect** displays a one-time device code and opens
GitHub's secure device page. Every person who downloads the repository signs in
with their own local GitHub credentials; no account, token, folder path, or
authentication state is included in this repository.

You can also authenticate GitHub CLI in a terminal:

```bash
gh auth login
```

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The command starts both the
dashboard and its loopback-only filesystem service. Choose **Choose folder** in
the header to select the parent directory that contains your projects. You can
use the native macOS folder browser or enter an absolute/`~/` path on any
platform. The choice is saved locally and is never committed.

Project names render first. Local Git, GitHub discovery, sync comparisons, and
per-project size measurements then publish independently in the background.
One slow or offloaded folder cannot hold healthy repositories behind its disk or
Git check, and a failed refresh keeps the last successfully measured size.

The header always shows the active parent folder. Use **Open** to reveal it in
the system file browser or **Change** to select another parent. Selecting the
folder already in use is an immediate no-op and keeps the current dashboard.

The dashboard talks directly to the loopback-only local service instead of
routing filesystem requests through the web preview. If that service stops or
cannot answer, the initial placeholders are replaced within five seconds by a
clear recovery message. Restart `npm run dev`, then choose **Retry now**; the
failed check does not change any project files or settings.

Every repository row includes **Status evidence** showing the local Git result,
the configured `origin`, the GitHub repository and latest push, and the basis of
the sync comparison. If GitHub has pushed history but the selected folder has no
local commits, Project Deck reports **Histories disconnected** and suppresses
the normal push action instead of assuming an exact-name match is safe.

When GitHub is disconnected, the header shows **Connect GitHub** rather than an
ambiguous status. The in-app device flow repairs expired credentials and unlocks
repository matching, creation, linking, and sync actions. Choose **Refresh** to
fetch current GitHub state after an external change.

## Configuration

The first launch defaults to `~/Documents`. The first-run setup and in-app
folder picker are the normal way to change it. These optional environment
variables are useful for development, testing, and managed installations:

- `GIT_SCAN_ROOT`: project root to scan instead of `~/Documents`
- `GIT_SCAN_API_PORT`: local service port instead of `4317`
- `GIT_SCAN_DISABLE_GITHUB=1`: skip GitHub CLI discovery
- `GIT_SCAN_EXTERNAL_GIT_ROOTS`: additional path-delimited roots to search for
  agent-managed Git directories (temporary Codex/Claude locations are checked
  automatically with bounded traversal)

## Checks

```bash
npm run lint
npx tsc --noEmit
npm test
```

`npm test` exercises the scanner against temporary folders, creates a production
build, and verifies the rendered dashboard shell.
