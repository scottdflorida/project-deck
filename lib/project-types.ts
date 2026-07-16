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

export interface ProjectRecord {
  name: string;
  pathLabel: string;
  summary: string;
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
}

export interface ProjectScanResponse {
  rootLabel: string;
  scannedAt: string;
  enriching?: boolean;
  github: {
    available: boolean;
    login: string | null;
  };
  projects: ProjectRecord[];
}

export interface ActionResponse {
  ok: true;
  message: string;
  project: ProjectRecord;
}
