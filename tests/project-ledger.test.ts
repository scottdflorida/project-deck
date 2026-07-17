import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRecord } from "../lib/project-types";
import { attentionReason, compareProjects, gitPresentation, githubPresentation, hasDisconnectedHistory, needsAttention, projectActionKey, projectActivity, projectInView, projectSearchText, syncPresentation } from "../lib/project-ledger";

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
  assert.deepEqual([...gitValues].sort((a, b) => compareProjects(a, b, "git", "asc")).map((item) => item.name), ["not-git", "no-commits", "changed", "cached-clean", "pending-git", "unavailable-git"]);
  assert.deepEqual([...gitValues].sort((a, b) => compareProjects(a, b, "git", "desc")).map((item) => item.name), ["cached-clean", "changed", "no-commits", "not-git", "pending-git", "unavailable-git"]);

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

test("unavailable Git metadata is neither presented as empty nor treated as actionable by itself", () => {
  const unavailable = project("offloaded", {
    git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, statusReason: "timeout", lastCommitAt: null, lastCommitMessage: null },
  });
  assert.equal(gitPresentation(unavailable).label, "Working tree not checked");
  assert.equal(attentionReason(unavailable), "No attention needed");
  assert.equal(needsAttention(unavailable), false);

  const matched = { ...unavailable, github: { state: "matched" as const, repository: unavailable.github.repository }, sync: { state: "no_remote" as const, ahead: 0, behind: 0, checkedRemote: false, detail: "No remote." } };
  assert.equal(needsAttention(matched), true);
  assert.equal(attentionReason(matched), "A GitHub repository is ready to link");
});

test("canonical presentations freeze user-visible state language and precedence", () => {
  const states = [
    [project("pending", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null }, transient: { git: "checking" } }), "Checking…"],
    [project("folder", { git: { isRepository: false, branch: null, hasCommits: false, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }), "Not initialized"],
    [project("empty", { git: { isRepository: true, branch: "main", hasCommits: false, changeCount: 0, statusAvailable: false, statusReason: "timeout", lastCommitAt: null, lastCommitMessage: null } }), "No local commits"],
    [project("changed", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 2, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }), "2 local changes"],
    [project("clean"), "Clean"],
    [project("cloud", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, statusReason: "offloaded", lastCommitAt: null, lastCommitMessage: null } }), "Files offloaded"],
    [project("slow", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, statusReason: "timeout", lastCommitAt: null, lastCommitMessage: null } }), "Working tree not checked"],
  ] as const;
  for (const [value, label] of states) assert.equal(gitPresentation(value).label, label);

  const matched = project("match", {
    github: { state: "matched", repository: { name: "match", nameWithOwner: "person/match", url: "https://github.com/person/match", isPrivate: false } },
    sync: { state: "no_remote", ahead: 0, behind: 0, checkedRemote: false, detail: "No remote." },
  });
  assert.equal(githubPresentation(matched).label, "Repository found");
  assert.equal(syncPresentation(matched).label, "Not linked");
  assert.match(syncPresentation(matched).detail, /person\/match/);
  assert.equal(projectActionKey(matched, true), "link");
  assert.match(projectSearchText(matched), /repository found/);
  assert.doesNotMatch(projectSearchText(matched), /no remote/);
});

test("latest activity uses Git history and never treats folder copying as project work", () => {
  const localCommit = project("local-newer", {
    modifiedAt: "2026-07-17T18:00:00.000Z",
    git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: true, lastCommitAt: "2026-07-10T12:00:00.000Z", lastCommitMessage: "Local work" },
    github: { state: "linked", repository: { name: "local-newer", nameWithOwner: "person/local-newer", url: "https://github.com/person/local-newer", isPrivate: true, pushedAt: "2026-07-09T12:00:00.000Z" } },
  });
  assert.deepEqual(projectActivity(localCommit), { at: "2026-07-10T12:00:00.000Z", source: "local_commit", message: "Local work" });

  const remoteNewer = project("remote-newer", {
    modifiedAt: "2026-07-01T18:00:00.000Z",
    git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: true, lastCommitAt: "2026-07-09T12:00:00.000Z", lastCommitMessage: "Older local work" },
    github: { state: "linked", repository: { name: "remote-newer", nameWithOwner: "person/remote-newer", url: "https://github.com/person/remote-newer", isPrivate: true, pushedAt: "2026-07-11T12:00:00.000Z" } },
  });
  assert.deepEqual(projectActivity(remoteNewer), { at: "2026-07-11T12:00:00.000Z", source: "github_push", message: null });

  const copiedOnly = project("copied-only", {
    modifiedAt: "2026-07-17T18:00:00.000Z",
    git: { isRepository: false, branch: null, hasCommits: false, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null },
    github: { state: "none", repository: null },
  });
  assert.deepEqual(projectActivity(copiedOnly), { at: null, source: "none", message: null });
});

test("a pushed same-name repository cannot masquerade as a safely linkable empty history", () => {
  const mismatch = project("lifting", {
    git: { isRepository: true, branch: "main", hasCommits: false, changeCount: 30, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null },
    github: { state: "matched", repository: { name: "lifting", nameWithOwner: "person/lifting", url: "https://github.com/person/lifting", isPrivate: true, pushedAt: "2026-07-17T18:29:31.000Z" } },
    sync: { state: "no_remote", ahead: 0, behind: 0, checkedRemote: false, detail: "No remote." },
  });
  assert.equal(hasDisconnectedHistory(mismatch), true);
  assert.equal(gitPresentation(mismatch).label, "No local commits");
  assert.equal(syncPresentation(mismatch).key, "history_mismatch");
  assert.equal(syncPresentation(mismatch).label, "Histories disconnected");
  assert.equal(projectActionKey(mismatch, true), "review_history");
  assert.match(attentionReason(mismatch), /local Git history is empty/);
  assert.equal(projectActivity(mismatch).source, "github_push");

  const linkedButEmpty = {
    ...mismatch,
    github: { ...mismatch.github, state: "linked" as const },
    sync: { state: "no_commits" as const, ahead: 0, behind: 0, checkedRemote: false, detail: "There are no local commits yet." },
  };
  assert.equal(hasDisconnectedHistory(linkedButEmpty), true);
  assert.equal(syncPresentation(linkedButEmpty).key, "history_mismatch");
  assert.equal(projectActionKey(linkedButEmpty, true), "review_history");
});

test("action guidance never calls an unchecked working tree up to date", () => {
  const offloaded = project("cloud", {
    git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, statusReason: "offloaded", lastCommitAt: null, lastCommitMessage: null },
  });
  assert.equal(syncPresentation(offloaded).key, "in_sync");
  assert.equal(projectActionKey(offloaded, true), "working_tree_not_checked");
});

test("categorical sorting groups exact displayed states and keeps unresolved states last", () => {
  const values = [
    project("clean-z"),
    project("clean-a"),
    project("changes-3", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 3, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }),
    project("changes-1", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 1, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }),
    project("not-git", { git: { isRepository: false, branch: null, hasCommits: false, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null } }),
    project("offloaded", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, statusReason: "offloaded", lastCommitAt: null, lastCommitMessage: null } }),
    project("not-checked", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, statusReason: "timeout", lastCommitAt: null, lastCommitMessage: null } }),
    project("checking", { git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null }, transient: { git: "checking" } }),
  ];
  for (const direction of ["asc", "desc"] as const) {
    const sorted = [...values].sort((a, b) => compareProjects(a, b, "git", direction));
    const labels = sorted.map((value) => gitPresentation(value).key);
    for (const key of new Set(labels)) {
      const indexes = labels.flatMap((value, index) => value === key ? [index] : []);
      assert.equal(indexes.at(-1)! - indexes[0] + 1, indexes.length, `${key} must be contiguous in ${direction}`);
    }
    assert.deepEqual(labels.slice(-3), ["checking", "offloaded", "not_checked"]);
  }
});
