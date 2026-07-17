import type { ProjectRecord } from "./project-types";

export type ProjectView = "working" | "attention" | "local" | "ignored";
export type SortKey = "name" | "size" | "git" | "github" | "sync";
export type SortDirection = "asc" | "desc";
export type PresentationTone = "good" | "warn" | "bad" | "neutral" | "checking" | "quiet";
export type PresentationResolution = "known" | "pending" | "not_checked";
export type GitPresentationKey = "not_initialized" | "no_commits" | "changes" | "clean" | "offloaded" | "not_checked" | "checking";
export type GithubPresentationKey = "none" | "match_found" | "linked" | "sign_in" | "checking";
export type SyncPresentationKey = "not_linked" | "history_mismatch" | "no_commits" | "not_pushed" | "ahead" | "behind" | "diverged" | "in_sync" | "not_checked" | "checking";

export type StatePresentation<Key extends string> = {
  key: Key;
  label: string;
  detail: string;
  tone: PresentationTone;
  resolution: PresentationResolution;
  actionable: boolean;
  refreshing: boolean;
  count: number;
};

export const gitRanks: readonly GitPresentationKey[] = ["not_initialized", "no_commits", "changes", "clean"];
export const githubRanks: readonly GithubPresentationKey[] = ["none", "match_found", "linked"];
export const syncRanks: readonly SyncPresentationKey[] = ["not_linked", "history_mismatch", "no_commits", "not_pushed", "ahead", "behind", "diverged", "in_sync"];

type SortProjection = { bucket: 0 | 1 | 2; rank: number; count: number };

function branchDetail(project: ProjectRecord) {
  const branch = project.git.branch || "Detached HEAD";
  return project.git.metadataSource === "agent_external" ? `${branch} · agent-managed Git metadata` : branch;
}

function validTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function hasDisconnectedHistory(project: ProjectRecord) {
  return (project.github.state === "matched" || project.github.state === "linked")
    && !project.git.hasCommits
    && validTimestamp(project.github.repository?.pushedAt) !== null;
}

export type ProjectActivity = {
  at: string | null;
  source: "local_commit" | "github_push" | "none";
  message: string | null;
};

/** Latest Git activity deliberately excludes filesystem mtimes: moving or
 * hydrating a folder is not project work. */
export function projectActivity(project: ProjectRecord): ProjectActivity {
  const localTime = validTimestamp(project.git.lastCommitAt);
  const githubTime = validTimestamp(project.github.repository?.pushedAt);
  if (localTime === null && githubTime === null) return { at: null, source: "none", message: null };
  if (githubTime !== null && (localTime === null || githubTime > localTime)) {
    return { at: project.github.repository?.pushedAt || null, source: "github_push", message: null };
  }
  return { at: project.git.lastCommitAt, source: "local_commit", message: project.git.lastCommitMessage };
}

export function gitPresentation(project: ProjectRecord): StatePresentation<GitPresentationKey> {
  const refreshing = project.transient?.git === "checking";
  if (!project.git.isRepository) {
    if (refreshing) return { key: "checking", label: "Checking…", detail: "Reading local Git metadata", tone: "checking", resolution: "pending", actionable: false, refreshing: false, count: 0 };
    return { key: "not_initialized", label: "Not initialized", detail: "This is a local folder without a Git repository.", tone: "neutral", resolution: "known", actionable: true, refreshing: false, count: 0 };
  }
  // HEAD is a tiny metadata read and remains truthful even when the worktree is
  // cloud-backed or slow. It must win over status enumeration failure.
  if (!project.git.hasCommits) return { key: "no_commits", label: "No local commits", detail: `${project.git.branch || "No branch yet"} · this folder’s .git has no HEAD commit`, tone: "warn", resolution: "known", actionable: true, refreshing, count: 0 };
  if (project.git.statusAvailable) {
    if (project.git.changeCount > 0) {
      const count = project.git.changeCount;
      return { key: "changes", label: `${count} local ${count === 1 ? "change" : "changes"}`, detail: branchDetail(project), tone: "warn", resolution: "known", actionable: true, refreshing, count };
    }
    return { key: "clean", label: "Clean", detail: branchDetail(project), tone: "good", resolution: "known", actionable: false, refreshing, count: 0 };
  }
  if (refreshing) return { key: "checking", label: "Checking…", detail: `${branchDetail(project)} · reading working tree`, tone: "checking", resolution: "pending", actionable: false, refreshing: false, count: 0 };
  if (project.git.statusReason === "offloaded") return { key: "offloaded", label: "Files offloaded", detail: "Download this project’s files from iCloud, then refresh.", tone: "quiet", resolution: "not_checked", actionable: false, refreshing: false, count: 0 };
  const reason = project.git.statusReason === "timeout" ? "The working files did not respond in time." : "The working files could not be read.";
  return { key: "not_checked", label: "Working tree not checked", detail: `${branchDetail(project)} · Git metadata was found. ${reason}`, tone: "quiet", resolution: "not_checked", actionable: false, refreshing: false, count: 0 };
}

export function githubPresentation(project: ProjectRecord): StatePresentation<GithubPresentationKey> {
  const refreshing = project.transient?.github === "checking";
  // A parseable local origin is proof of linkage independent of GitHub auth.
  if (project.github.state === "linked") return { key: "linked", label: "Linked", detail: project.github.repository?.nameWithOwner || "GitHub origin", tone: "good", resolution: "known", actionable: false, refreshing, count: 0 };
  if (project.github.state === "matched") return { key: "match_found", label: "Repository found", detail: `${project.github.repository?.nameWithOwner || "Same-name repository"} · exact-name match only; this folder has no origin`, tone: "warn", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: 0 };
  if (refreshing) return { key: "checking", label: "Checking…", detail: "Looking for GitHub repositories", tone: "checking", resolution: "pending", actionable: false, refreshing: false, count: 0 };
  if (project.github.state === "unavailable") return { key: "sign_in", label: "Sign in to check", detail: "Connect GitHub to discover repositories.", tone: "quiet", resolution: "not_checked", actionable: !project.preferences.localOnly, refreshing: false, count: 0 };
  return { key: "none", label: "No repository", detail: "No linked or matching GitHub repository was found.", tone: "neutral", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: 0 };
}

export function syncPresentation(project: ProjectRecord): StatePresentation<SyncPresentationKey> {
  const refreshing = project.transient?.sync === "checking";
  const state = project.sync.state;
  if (hasDisconnectedHistory(project)) return { key: "history_mismatch", label: "Histories disconnected", detail: "GitHub has pushed history, but this folder has no local commits. Do not push until its Git metadata is repaired or the repository is cloned again.", tone: "bad", resolution: "known", actionable: false, refreshing, count: 0 };
  if (state === "in_sync") return { key: "in_sync", label: "In sync", detail: project.sync.detail, tone: "good", resolution: "known", actionable: false, refreshing, count: 0 };
  if (state === "ahead") return { key: "ahead", label: `${project.sync.ahead} ahead`, detail: project.sync.detail, tone: "warn", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: project.sync.ahead };
  if (state === "behind") return { key: "behind", label: `${project.sync.behind} behind`, detail: project.sync.detail, tone: "bad", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: project.sync.behind };
  if (state === "diverged") return { key: "diverged", label: `${project.sync.ahead} ahead · ${project.sync.behind} behind`, detail: project.sync.detail, tone: "bad", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: project.sync.ahead + project.sync.behind };
  if (state === "unpublished") return { key: "not_pushed", label: "Not pushed", detail: project.sync.detail, tone: "warn", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: 0 };
  if (state === "no_commits") return { key: "no_commits", label: "No commits", detail: project.sync.detail, tone: "neutral", resolution: "known", actionable: !project.preferences.localOnly, refreshing, count: 0 };
  if (state === "no_remote") {
    const repository = project.github.state === "matched" ? project.github.repository?.nameWithOwner : null;
    return { key: "not_linked", label: "Not linked", detail: repository ? `${repository} was found. Link it to compare this project.` : "No local GitHub origin is configured.", tone: project.github.state === "matched" ? "warn" : "neutral", resolution: "known", actionable: project.github.state === "matched" && !project.preferences.localOnly, refreshing, count: 0 };
  }
  if (refreshing) return { key: "checking", label: "Checking…", detail: "Comparing local and GitHub refs", tone: "checking", resolution: "pending", actionable: false, refreshing: false, count: 0 };
  return { key: "not_checked", label: "Comparison not checked", detail: project.sync.detail || "The linked refs could not be compared.", tone: "quiet", resolution: "not_checked", actionable: false, refreshing: false, count: 0 };
}

export type ProjectActionKey = "checking_git" | "init" | "link" | "create" | "checking_sync" | "reconcile" | "review_history" | "working_tree_not_checked" | "comparison_not_checked" | "external_session" | "push" | "up_to_date" | "connect_github" | "local_only" | "none";

export function projectActionKey(project: ProjectRecord, githubAvailable: boolean): ProjectActionKey {
  const git = gitPresentation(project);
  const github = githubPresentation(project);
  const sync = syncPresentation(project);
  if (git.key === "checking") return "checking_git";
  if (project.preferences.localOnly) return git.key === "not_initialized" ? "init" : "local_only";
  if (sync.key === "history_mismatch") return "review_history";
  if (project.git.metadataSource === "agent_external" && (git.key === "changes" || git.key === "no_commits" || github.actionable || sync.actionable)) return "external_session";
  if (git.key === "not_initialized") return github.key === "match_found" ? "link" : "init";
  if (github.key === "match_found") return "link";
  if (github.key === "none" && githubAvailable) return "create";
  if (github.key === "linked") {
    if (sync.key === "checking") return "checking_sync";
    if (sync.key === "behind" || sync.key === "diverged") return "reconcile";
    if (sync.key === "not_checked") return "comparison_not_checked";
    if (git.key === "no_commits" || git.key === "changes" || sync.key === "ahead" || sync.key === "not_pushed") return "push";
    if (git.key === "offloaded" || git.key === "not_checked") return "working_tree_not_checked";
    if (sync.key === "in_sync") return "up_to_date";
  }
  if (github.key === "sign_in" && !githubAvailable) return "connect_github";
  return "none";
}

export function needsAttention(project: ProjectRecord) {
  const git = gitPresentation(project);
  if (git.key === "checking") return false;
  if (["not_initialized", "no_commits", "changes"].includes(git.key)) return true;
  if (project.preferences.localOnly) return false;
  const github = githubPresentation(project);
  if (github.key === "checking") return false;
  if (github.key !== "linked") return true;
  const sync = syncPresentation(project);
  return ["ahead", "behind", "diverged", "not_pushed", "no_commits", "not_linked"].includes(sync.key);
}

export function attentionReason(project: ProjectRecord) {
  const git = gitPresentation(project);
  if (git.key === "checking") return "Local Git status is being checked";
  if (hasDisconnectedHistory(project)) return "GitHub has commits, but this folder’s local Git history is empty";
  if (git.key === "not_initialized") return "Git is not initialized";
  if (git.key === "no_commits") return "This folder has no local commits";
  if (git.key === "changes") return git.label;
  if (project.preferences.localOnly) return "Local Git is settled";
  const github = githubPresentation(project);
  if (github.key === "match_found") return "A GitHub repository is ready to link";
  if (github.key === "none") return "No GitHub repository is linked";
  if (github.key === "sign_in") return "Sign in to check for a GitHub repository";
  const sync = syncPresentation(project);
  if (sync.actionable) return sync.detail;
  return "No attention needed";
}

export function projectSearchText(project: ProjectRecord) {
  const git = gitPresentation(project);
  const github = githubPresentation(project);
  const sync = syncPresentation(project);
  return [project.name, project.description.text, project.description.sourceLabel, project.canonicalPath, project.pathLabel, ...project.technologies, git.label, git.detail, project.git.branch, github.label, github.detail, project.github.repository?.name, project.github.repository?.nameWithOwner, sync.label, sync.detail].filter(Boolean).join(" ").toLowerCase();
}

export function projectInView(project: ProjectRecord, view: ProjectView) {
  if (view === "ignored") return project.preferences.ignored;
  if (project.preferences.ignored) return false;
  if (view === "local") return project.preferences.localOnly;
  if (view === "attention") return needsAttention(project);
  return true;
}

function codePointCompare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function stableIdentity(a: ProjectRecord, b: ProjectRecord) {
  const folded = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  return folded || codePointCompare(a.name, b.name) || codePointCompare(a.canonicalPath, b.canonicalPath);
}
function exactIdentityTie(a: ProjectRecord, b: ProjectRecord) { return codePointCompare(a.name, b.name) || codePointCompare(a.canonicalPath, b.canonicalPath); }

function projection<Key extends string>(view: StatePresentation<Key>, ranks: readonly Key[]): SortProjection {
  if (view.resolution === "known") return { bucket: 0, rank: Math.max(0, ranks.indexOf(view.key)), count: view.count };
  if (view.resolution === "pending") return { bucket: 1, rank: 0, count: 0 };
  // Keep each settled unknown label contiguous and after known groups in both directions.
  return { bucket: 2, rank: view.key === "offloaded" ? 0 : view.key === "sign_in" ? 1 : 2, count: 0 };
}

export function gitProjection(project: ProjectRecord) { return projection(gitPresentation(project), gitRanks); }
function githubProjection(project: ProjectRecord) { return projection(githubPresentation(project), githubRanks); }
function syncProjection(project: ProjectRecord) { return projection(syncPresentation(project), syncRanks); }
function sizeProjection(project: ProjectRecord): SortProjection {
  if (project.size.status === "complete") return { bucket: 0, rank: project.size.bytes, count: 0 };
  return { bucket: project.transient?.size ? 1 : 2, rank: 0, count: 0 };
}

function compareProjection(a: SortProjection, b: SortProjection, direction: SortDirection) {
  if (a.bucket !== b.bucket) return a.bucket - b.bucket;
  if (a.bucket !== 0) return a.rank - b.rank;
  const multiplier = direction === "asc" ? 1 : -1;
  return (a.rank - b.rank) * multiplier || (a.count - b.count) * multiplier;
}

export function compareProjects(a: ProjectRecord, b: ProjectRecord, key: SortKey, direction: SortDirection) {
  const multiplier = direction === "asc" ? 1 : -1;
  if (key === "name") {
    const primary = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return primary ? multiplier * primary : exactIdentityTie(a, b);
  }
  if (key === "size") return compareProjection(sizeProjection(a), sizeProjection(b), direction) || stableIdentity(a, b);
  const aProjection = key === "git" ? gitProjection(a) : key === "github" ? githubProjection(a) : syncProjection(a);
  const bProjection = key === "git" ? gitProjection(b) : key === "github" ? githubProjection(b) : syncProjection(b);
  return compareProjection(aProjection, bProjection, direction) || stableIdentity(a, b);
}

export const sortRankLabels = { gitRanks, githubRanks, syncRanks };
