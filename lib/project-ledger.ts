import type { GithubState, ProjectRecord, SyncState } from "./project-types";

export type ProjectView = "working" | "attention" | "local" | "ignored";
export type SortKey = "name" | "size" | "git" | "github" | "sync";
export type SortDirection = "asc" | "desc";
type SortProjection = { bucket: 0 | 1 | 2; rank: number; count: number };

const gitRanks = ["not_git", "no_commits", "changes", "clean"] as const;
const githubRanks: GithubState[] = ["none", "matched", "linked"];
const syncRanks: SyncState[] = [
  "no_remote", "no_commits", "unpublished", "ahead", "behind", "diverged", "in_sync",
];

function codePointCompare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableIdentity(a: ProjectRecord, b: ProjectRecord) {
  const folded = a.name.localeCompare(b.name, undefined, {
    sensitivity: "base", numeric: true,
  });
  return folded || codePointCompare(a.name, b.name) || codePointCompare(a.canonicalPath, b.canonicalPath);
}

function exactIdentityTie(a: ProjectRecord, b: ProjectRecord) {
  return codePointCompare(a.name, b.name) || codePointCompare(a.canonicalPath, b.canonicalPath);
}

export function gitProjection(project: ProjectRecord) {
  if (!project.git.isRepository && project.transient?.git) return { bucket: 1, rank: 0, count: 0 } satisfies SortProjection;
  if (!project.git.isRepository) return { bucket: 0, rank: 0, count: 0 } satisfies SortProjection;
  if (!project.git.hasCommits) return { bucket: 0, rank: 1, count: 0 } satisfies SortProjection;
  if (!project.git.statusAvailable) return { bucket: project.transient?.git ? 1 : 2, rank: 0, count: 0 } satisfies SortProjection;
  return project.git.changeCount > 0
    ? { bucket: 0, rank: 2, count: project.git.changeCount } satisfies SortProjection
    : { bucket: 0, rank: 3, count: 0 } satisfies SortProjection;
}

export function needsAttention(project: ProjectRecord) {
  if (!project.git.isRepository || !project.git.hasCommits || !project.git.statusAvailable || project.git.changeCount > 0) return true;
  if (project.preferences.localOnly) return false;
  return project.github.state !== "linked" || project.sync.state !== "in_sync";
}

export function attentionReason(project: ProjectRecord) {
  if (!project.git.isRepository) return "Git is not initialized";
  if (!project.git.hasCommits) return "The repository has no commits";
  if (!project.git.statusAvailable) return "Local Git status is unavailable";
  if (project.git.changeCount > 0) return `${project.git.changeCount} local ${project.git.changeCount === 1 ? "change" : "changes"}`;
  if (project.preferences.localOnly) return "Local Git is settled";
  if (project.github.state !== "linked") return project.github.state === "matched" ? "A GitHub match is ready to link" : "No GitHub repository is linked";
  if (project.sync.state !== "in_sync") return project.sync.detail;
  return "No attention needed";
}

export function projectInView(project: ProjectRecord, view: ProjectView) {
  if (view === "ignored") return project.preferences.ignored;
  if (project.preferences.ignored) return false;
  if (view === "local") return project.preferences.localOnly;
  if (view === "attention") return needsAttention(project);
  return true;
}

function compareProjection(a: SortProjection, b: SortProjection, direction: SortDirection) {
  if (a.bucket !== b.bucket) return a.bucket - b.bucket;
  if (a.bucket !== 0) return 0;
  const multiplier = direction === "asc" ? 1 : -1;
  return (a.rank - b.rank) * multiplier || (a.count - b.count) * multiplier;
}

function sizeProjection(project: ProjectRecord): SortProjection {
  if (project.size.status === "complete") return { bucket: 0, rank: project.size.bytes, count: 0 };
  return { bucket: project.transient?.size ? 1 : 2, rank: 0, count: 0 };
}

function githubProjection(project: ProjectRecord): SortProjection {
  if (project.github.state === "unavailable") return { bucket: project.transient?.github ? 1 : 2, rank: 0, count: 0 };
  return { bucket: 0, rank: Math.max(0, githubRanks.indexOf(project.github.state)), count: 0 };
}

function syncProjection(project: ProjectRecord): SortProjection {
  if (project.sync.state === "unavailable") return { bucket: project.transient?.sync ? 1 : 2, rank: 0, count: 0 };
  return { bucket: 0, rank: Math.max(0, syncRanks.indexOf(project.sync.state)), count: project.sync.ahead + project.sync.behind };
}

export function compareProjects(a: ProjectRecord, b: ProjectRecord, key: SortKey, direction: SortDirection) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (key === "name") {
    const primary = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return primary ? multiplier * primary : exactIdentityTie(a, b);
  }
  if (key === "size") {
    return compareProjection(sizeProjection(a), sizeProjection(b), direction) || stableIdentity(a, b);
  }

  const aProjection = key === "git" ? gitProjection(a) : key === "github" ? githubProjection(a) : syncProjection(a);
  const bProjection = key === "git" ? gitProjection(b) : key === "github" ? githubProjection(b) : syncProjection(b);
  return compareProjection(aProjection, bProjection, direction) || stableIdentity(a, b);
}

export const sortRankLabels = { gitRanks, githubRanks, syncRanks };
