# Project Deck

Project Deck is a portable local dashboard for every direct folder inside a
parent directory you choose. It measures each project, detects Git and GitHub
state, compares local branches with their remotes, and puts common repository
actions in one place.

## What it shows

- Descriptions from README/ABOUT/OVERVIEW files or project manifests, with the
  exact source shown beside each description
- Total on-disk size for every project
- Git status, current branch, recent activity, and working-tree changes
- Exact-name GitHub matches and linked `origin` repositories
- Ahead, behind, diverged, unpublished, and in-sync states
- Sorting by name, size, Git, GitHub, or sync state in either direction
- Working set, needs-attention, local-only, and ignored views
- Search and a responsive project ledger

If no useful local description is found, Project Deck says so rather than
inventing one. You can add a private local description from the project's menu.
Local descriptions are saved in Project Deck's settings and never edit project
files.

**Copy folder path** copies that project's canonical absolute path. It is kept
next to the visible path rather than presented as an unexplained project action.

Projects marked **Ignored** are hidden from normal views but remain available in
the Ignored view and can be restored. Projects marked **Local only** keep their
local Git information while suppressing GitHub publishing prompts and
remote-derived attention. Neither preference changes project files, Git remotes,
or GitHub repositories.

## Available actions

- Initialize a folder as a Git repository on `main`
- Link an exact-name repository already in your GitHub account
- Create a private or public GitHub repository
- Stage, commit, and push local changes

Pushes stop when the remote branch is ahead or diverged. Obvious untracked
secret files such as `.env`, private keys, and credential JSON files are blocked
before staging.

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

Project names render first, local Git repositories and linked remotes follow,
then sizes and detailed sync checks continue independently in the background.
One slow folder cannot hold repository discovery behind disk measurement.

The header always shows the active parent folder. Use **Open** to reveal it in
the system file browser or **Change** to select another parent. Selecting the
folder already in use is an immediate no-op and keeps the current dashboard.

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

## Checks

```bash
npm run lint
npx tsc --noEmit
npm test
```

`npm test` exercises the scanner against temporary folders, creates a production
build, and verifies the rendered dashboard shell.
