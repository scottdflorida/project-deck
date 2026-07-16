# Project Deck

Project Deck is a portable local dashboard for every direct folder inside a
parent directory you choose. It measures each project, detects Git and GitHub
state, compares local branches with their remotes, and puts common repository
actions in one place.

## What it shows

- Project summaries from `package.json`, `pyproject.toml`, `Cargo.toml`, or a README
- Total on-disk size for every project
- Git status, current branch, recent activity, and working-tree changes
- Exact-name GitHub matches and linked `origin` repositories
- Ahead, behind, diverged, unpublished, and in-sync states
- Search, health filters, and responsive project cards

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

Authenticate GitHub CLI once if needed:

```bash
gh auth login
```

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The command starts both the
dashboard and its loopback-only filesystem service. Choose **Folder** in the
header to select the parent directory that contains your projects. You can use
the native macOS folder browser or enter an absolute/`~/` path on any platform.
The choice is saved locally and is never committed.

Project names render first, sizes follow, and Git/GitHub details enrich in the
background so large folders do not block the dashboard. Choose **Refresh** to
fetch current GitHub state.

## Configuration

The first launch defaults to `~/Documents`. The in-app folder picker is the
normal way to change it. These optional environment variables are useful for
development, testing, and managed installations:

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
