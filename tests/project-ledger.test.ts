import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRecord } from "../lib/project-types";
import { attentionReason, compareProjects, needsAttention, projectInView } from "../lib/project-ledger";

function project(name: string, patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    name,
    canonicalPath: `/work/${name}`,
    pathLabel: `~/work/${name}`,
    description: { text: "A useful project description for testing.", compact: "A useful project description for testing.", source: "file", sourceLabel: "From README.md", sourceFile: "README.md" },
    summary: "A useful project description for testing.",
    preferences: { ignored: false, localOnly: false },
    technologies: [], modifiedAt: "2026-01-01T00:00:00.000Z",
    size: { status: "complete", bytes: 100 },
    git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null },
    github: { state: "linked", repository: { name, nameWithOwner: `person/${name}`, url: `https://github.com/person/${name}`, isPrivate: true } },
    sync: { state: "in_sync", ahead: 0, behind: 0, checkedRemote: true, detail: "In sync." },
    ...patch,
  };
}

test("sorts every requested projection while leaving unavailable values last", () => {
  const values = [
    project("clean"),
    project("not-git", { git: { isRepository: false, branch: null, hasCommits: false, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }),
    project("changes", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 3, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }),
    project("unknown", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null }, size: { status: "error", code: "measurement_failed", message: "Size unavailable because part of this folder could not be read." } }),
  ];
  assert.deepEqual([...values].sort((a, b) => compareProjects(a, b, "git", "asc")).map((item) => item.name), ["not-git", "changes", "clean", "unknown"]);
  assert.deepEqual([...values].sort((a, b) => compareProjects(a, b, "git", "desc")).map((item) => item.name), ["clean", "changes", "not-git", "unknown"]);
  assert.equal([...values].sort((a, b) => compareProjects(a, b, "size", "desc")).at(-1)?.name, "unknown");
});

test("keeps known facts ranked, pending facts next, and unavailable facts last in both directions", () => {
  const unavailableSize = { status: "error", code: "measurement_failed", message: "Size unavailable because part of this folder could not be read." } as const;
  const sizeValues = [
    project("large", { size: { status: "complete", bytes: 900 } }),
    project("pending-size", { size: unavailableSize, transient: { size: "checking" } }),
    project("unavailable-size", { size: unavailableSize }),
    project("small-cached", { size: { status: "complete", bytes: 10 }, transient: { size: "checking" } }),
  ];
  assert.deepEqual([...sizeValues].sort((a, b) => compareProjects(a, b, "size", "asc")).map((item) => item.name), ["small-cached", "large", "pending-size", "unavailable-size"]);
  assert.deepEqual([...sizeValues].sort((a, b) => compareProjects(a, b, "size", "desc")).map((item) => item.name), ["large", "small-cached", "pending-size", "unavailable-size"]);

  const pendingGit = project("pending-git", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null }, transient: { git: "checking" } });
  const unavailableGit = project("unavailable-git", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null } });
  const noCommitsDuringRefresh = project("no-commits", { git: { isRepository: true, branch: "main", hasCommits: false, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null }, transient: { git: "checking" } });
  const cachedClean = project("cached-clean", { transient: { git: "checking" } });
  const notGit = project("not-git", { git: { isRepository: false, branch: null, hasCommits: false, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } });
  const changed = project("changed", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 2, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } });
  const gitValues = [pendingGit, unavailableGit, cachedClean, noCommitsDuringRefresh, changed, notGit];
  assert.deepEqual([...gitValues].sort((a, b) => compareProjects(a, b, "git", "asc")).map((item) => item.name), ["not-git", "changed", "cached-clean", "no-commits", "pending-git", "unavailable-git"]);
  assert.deepEqual([...gitValues].sort((a, b) => compareProjects(a, b, "git", "desc")).map((item) => item.name), ["cached-clean", "changed", "not-git", "no-commits", "pending-git", "unavailable-git"]);

  const githubValues = [
    project("none", { github: { state: "none", repository: null } }),
    project("matched", { github: { state: "matched", repository: null } }),
    project("linked-cached", { transient: { github: "checking" } }),
    project("pending-github", { github: { state: "unavailable", repository: null }, transient: { github: "checking" } }),
    project("unavailable-github", { github: { state: "unavailable", repository: null } }),
  ];
  assert.deepEqual([...githubValues].sort((a, b) => compareProjects(a, b, "github", "asc")).map((item) => item.name), ["none", "matched", "linked-cached", "pending-github", "unavailable-github"]);
  assert.deepEqual([...githubValues].sort((a, b) => compareProjects(a, b, "github", "desc")).map((item) => item.name), ["linked-cached", "matched", "none", "pending-github", "unavailable-github"]);

  const syncValues = [
    project("no-remote", { sync: { state: "no_remote", ahead: 0, behind: 0, checkedRemote: false, detail: "No remote." } }),
    project("ahead", { sync: { state: "ahead", ahead: 2, behind: 0, checkedRemote: true, detail: "Ahead." } }),
    project("in-sync-cached", { transient: { sync: "checking" } }),
    project("pending-sync", { sync: { state: "unavailable", ahead: 0, behind: 0, checkedRemote: false, detail: "Checking." }, transient: { sync: "checking" } }),
    project("unavailable-sync", { sync: { state: "unavailable", ahead: 0, behind: 0, checkedRemote: false, detail: "Unavailable." } }),
  ];
  assert.deepEqual([...syncValues].sort((a, b) => compareProjects(a, b, "sync", "asc")).map((item) => item.name), ["no-remote", "ahead", "in-sync-cached", "pending-sync", "unavailable-sync"]);
  assert.deepEqual([...syncValues].sort((a, b) => compareProjects(a, b, "sync", "desc")).map((item) => item.name), ["in-sync-cached", "ahead", "no-remote", "pending-sync", "unavailable-sync"]);
});

test("name direction reverses the primary name but keeps exact ties deterministic", () => {
  const values = [project("Atlas 10"), project("atlas 2"), project("ATLAS 2", { canonicalPath: "/z/atlas" })];
  assert.deepEqual([...values].sort((a, b) => compareProjects(a, b, "name", "asc")).map((item) => item.name), ["ATLAS 2", "atlas 2", "Atlas 10"]);
  assert.deepEqual([...values].sort((a, b) => compareProjects(a, b, "name", "desc")).map((item) => item.name), ["Atlas 10", "ATLAS 2", "atlas 2"]);
});

test("local-only intent ignores remote attention without hiding local Git concerns", () => {
  const remoteMissing = project("local", { preferences: { ignored: false, localOnly: true }, github: { state: "none", repository: null }, sync: { state: "no_remote", ahead: 0, behind: 0, checkedRemote: false, detail: "No remote." } });
  assert.equal(needsAttention(remoteMissing), false);
  assert.equal(projectInView(remoteMissing, "local"), true);
  const localChange = project("changed", { preferences: { ignored: false, localOnly: true }, git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 1, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } });
  assert.equal(needsAttention(localChange), true);
  assert.equal(projectInView({ ...localChange, preferences: { ignored: true, localOnly: true } }, "attention"), false);
});

test("pending Git discovery is not mislabeled as a project needing attention", () => {
  const pending = project("pending", {
    git: { isRepository: false, branch: null, hasCommits: false, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null },
    github: { state: "unavailable", repository: null },
    sync: { state: "unavailable", ahead: 0, behind: 0, checkedRemote: false, detail: "Checking." },
    transient: { git: "checking", github: "checking", sync: "checking" },
  });
  assert.equal(needsAttention(pending), false);
  assert.equal(projectInView(pending, "attention"), false);
});

test("unavailable Git metadata is never presented as a known empty repository", () => {
  const unavailable = project("offloaded", {
    git: { isRepository: true, branch: null, hasCommits: false, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null },
  });
  assert.equal(attentionReason(unavailable), "Local Git status is unavailable");
  assert.equal(needsAttention(unavailable), true);
});
