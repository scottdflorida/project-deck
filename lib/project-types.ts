export type GithubState = "linked" | "matched" | "none" | "unavailable";

export type SyncState =
  | "in_sync"
  | "ahead"
  | "behind"
  | "diverged"
  | "unpublished"
  | "no_remote"
  | "no_commits"
  | "unavailable";

export interface GithubRepository {
  name: string;
  nameWithOwner: string;
  url: string;
  isPrivate: boolean | null;
}

export type ProjectSize =
  | { status: "complete"; bytes: number }
  | {
      status: "error";
      code: "measurement_failed";
      message: "Size unavailable because part of this folder could not be read.";
    };

export type DescriptionSource = "local" | "file" | "none" | "checking";

export interface ProjectDescription {
  /** Full normalized value. Never visually-derived or line-clamped. */
  text: string;
  /** Deterministic 180-code-point ledger value. */
  compact: string;
  source: DescriptionSource;
  sourceLabel: string;
  sourceFile: string | null;
}

export interface ProjectPreferences {
  ignored: boolean;
  localOnly: boolean;
}

export interface ProjectRecord {
  name: string;
  canonicalPath: string;
  pathLabel: string;
  description: ProjectDescription;
  /** Kept as a compact compatibility alias for existing clients. */
  summary: string;
  preferences: ProjectPreferences;
  technologies: string[];
  modifiedAt: string;
  size: ProjectSize;
  git: {
    isRepository: boolean;
    branch: string | null;
    hasCommits: boolean;
    changeCount: number;
    statusAvailable: boolean;
    lastCommitAt: string | null;
    lastCommitMessage: string | null;
  };
  github: {
    state: GithubState;
    repository: GithubRepository | null;
  };
  sync: {
    state: SyncState;
    ahead: number;
    behind: number;
    checkedRemote: boolean;
    detail: string;
  };
  /** Facts still being refreshed. A usable value in the matching field is the
   * last successful value; an unavailable placeholder is pending, not failed. */
  transient?: Partial<Record<"size" | "git" | "github" | "sync", "checking">>;
}

export interface ProjectScanResponse {
  rootPath: string;
  rootLabel: string;
  scannedAt: string;
  enriching?: boolean;
  github: {
    available: boolean;
    login: string | null;
  };
  projects: ProjectRecord[];
}

export interface UnchangedRootResponse {
  unchanged: true;
}

export type RootSelectionResponse = ProjectScanResponse | UnchangedRootResponse;

export interface ActionResponse {
  ok: true;
  message: string;
  project: ProjectRecord;
}

export interface ActionFailureResponse {
  ok: false;
  error: string;
  code?: string;
  project?: ProjectRecord;
}
