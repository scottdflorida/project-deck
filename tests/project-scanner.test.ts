import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeProjectPath, commitAndPushProject, compactDescription, createGithubRepository, descriptionFromOverview, discoverProjectDescription, getSyncState, includesTrackedOffloadedPath, initializeProject, linkMatchedRepository, loadProjectsRoot, ProjectActionError, scanProjects, scanProjectsQuick, setProjectPreferences } from "../server/project-scanner";
import type { ProjectRecord } from "../lib/project-types";
import { measureProjectSize } from "../server/project-scanner";
import { formatProjectSize } from "../lib/format-project-size";

test("scans direct folders, reads descriptions, and reports Git state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-deck-test-"));
  const previousRoot = process.env.GIT_SCAN_ROOT;
  const previousGithubSetting = process.env.GIT_SCAN_DISABLE_GITHUB;
  process.env.GIT_SCAN_ROOT = root;
  process.env.GIT_SCAN_DISABLE_GITHUB = "1";

  try {
    const alpha = path.join(root, "alpha");
    const bravo = path.join(root, "bravo");
    const outside = await mkdtemp(path.join(tmpdir(), "project-deck-outside-"));
    await Promise.all([mkdir(alpha), mkdir(bravo)]);
    await writeFile(
      path.join(alpha, "package.json"),
      JSON.stringify({ name: "alpha", description: "A focused local project dashboard." }),
    );
    await writeFile(
      path.join(bravo, "README.md"),
      "# Bravo\n\nTracks release notes and deployment checklists for a small team.\n",
    );
    await writeFile(path.join(bravo, "notes.txt"), "hello\n");
    await symlink(outside, path.join(root, "linked-folder"));

    execFileSync("git", ["init", "-b", "main"], { cwd: bravo });
    execFileSync("git", ["config", "user.name", "Project Deck Test"], { cwd: bravo });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: bravo });
    execFileSync("git", ["add", "README.md", "notes.txt"], { cwd: bravo });
    execFileSync("git", ["commit", "-m", "Initial test fixture"], { cwd: bravo });

    const result = await scanProjects(false);
    assert.equal(result.projects.length, 2);
    assert.deepEqual(
      result.projects.map((project) => project.name),
      ["alpha", "bravo"],
    );
    assert.equal(result.projects[0].summary, "A focused local project dashboard.");
    assert.equal(result.projects[0].git.isRepository, false);
    assert.deepEqual(result.projects[0].size, {
      status: "complete",
      bytes: Buffer.byteLength(JSON.stringify({ name: "alpha", description: "A focused local project dashboard." })),
    });
    assert.equal(result.projects[1].git.isRepository, true);
    assert.equal(result.projects[1].git.branch, "main");
    assert.equal(result.projects[1].git.changeCount, 0);
    assert.equal(result.projects[1].git.statusAvailable, true);
    assert.equal(result.projects[1].sync.state, "no_remote");

    const initialized = await initializeProject("alpha");
    assert.equal(initialized.project.git.isRepository, true);
    assert.equal(initialized.project.git.branch, "main");

    await rm(outside, { recursive: true, force: true });
  } finally {
    if (previousRoot === undefined) delete process.env.GIT_SCAN_ROOT;
    else process.env.GIT_SCAN_ROOT = previousRoot;
    if (previousGithubSetting === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB;
    else process.env.GIT_SCAN_DISABLE_GITHUB = previousGithubSetting;
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes local Git and remote facts before slower size enrichment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-quick-facts-test-"));
  const previousRoot = process.env.GIT_SCAN_ROOT;
  const previousGithubSetting = process.env.GIT_SCAN_DISABLE_GITHUB;
  const previousNativeSize = process.env.GIT_SCAN_USE_NATIVE_SIZE;
  process.env.GIT_SCAN_ROOT = root;
  process.env.GIT_SCAN_DISABLE_GITHUB = "1";
  process.env.GIT_SCAN_USE_NATIVE_SIZE = "0";

  try {
    const alpha = path.join(root, "alpha");
    await mkdir(path.join(alpha, ".git", "refs", "heads"), { recursive: true });
    await writeFile(path.join(alpha, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(alpha, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
    await writeFile(path.join(alpha, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/example/alpha.git\n');
    await writeFile(path.join(alpha, "README.md"), "Alpha is a useful local project with a linked GitHub repository.\n");
    await loadProjectsRoot();

    let staged: ProjectRecord | undefined;
    const completed = await scanProjectsQuick(true, (response) => {
      staged = response.projects[0];
    });

    assert.equal(staged?.git.isRepository, true);
    assert.equal(staged?.git.branch, "main");
    assert.equal(staged?.git.hasCommits, true);
    assert.equal(staged?.github.state, "linked");
    assert.equal(staged?.transient?.size, "checking");
    assert.equal(completed.projects[0].size.status, "complete");
    assert.equal(completed.projects[0].github.state, "linked");
  } finally {
    if (previousRoot === undefined) delete process.env.GIT_SCAN_ROOT; else process.env.GIT_SCAN_ROOT = previousRoot;
    if (previousGithubSetting === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB; else process.env.GIT_SCAN_DISABLE_GITHUB = previousGithubSetting;
    if (previousNativeSize === undefined) delete process.env.GIT_SCAN_USE_NATIVE_SIZE; else process.env.GIT_SCAN_USE_NATIVE_SIZE = previousNativeSize;
    await rm(root, { recursive: true, force: true });
  }
});

test("offloaded-file detection ignores unrelated placeholders and catches tracked paths", () => {
  const projectPath = "/work/project";
  const offloaded = `${projectPath}/ignored-preview.png\u0000${projectPath}/src/tracked.ts\u0000`;
  assert.equal(includesTrackedOffloadedPath(projectPath, offloaded, "README.md\u0000src/tracked.ts\u0000"), true);
  assert.equal(includesTrackedOffloadedPath(projectPath, `${projectPath}/ignored-preview.png\u0000`, "README.md\u0000src/tracked.ts\u0000"), false);
});

test("one slow Git worktree times out without corrupting a healthy repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-git-timeout-test-"));
  const oldRoot = process.env.GIT_SCAN_ROOT;
  const oldGithub = process.env.GIT_SCAN_DISABLE_GITHUB;
  const oldTimeout = process.env.GIT_SCAN_STATUS_TIMEOUT_MS;
  process.env.GIT_SCAN_ROOT = root;
  process.env.GIT_SCAN_DISABLE_GITHUB = "1";
  process.env.GIT_SCAN_STATUS_TIMEOUT_MS = "150";
  try {
    const healthy = path.join(root, "healthy");
    const slow = path.join(root, "slow");
    await Promise.all([mkdir(healthy), mkdir(slow)]);
    for (const projectPath of [healthy, slow]) {
      await writeFile(path.join(projectPath, "README.md"), `${path.basename(projectPath)}\n`);
      execFileSync("git", ["init", "-b", "main"], { cwd: projectPath });
      execFileSync("git", ["config", "user.name", "Project Deck Test"], { cwd: projectPath });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectPath });
      execFileSync("git", ["add", "README.md"], { cwd: projectPath });
      execFileSync("git", ["commit", "-m", "Initial fixture"], { cwd: projectPath });
    }
    const monitor = path.join(root, "slow-fsmonitor.sh");
    await writeFile(monitor, "#!/bin/sh\nsleep 5\n");
    await chmod(monitor, 0o755);
    execFileSync("git", ["config", "core.fsmonitor", monitor], { cwd: slow });
    await loadProjectsRoot();

    const result = await scanProjects(false);
    const healthyProject = result.projects.find((project) => project.name === "healthy");
    const slowProject = result.projects.find((project) => project.name === "slow");
    assert.equal(healthyProject?.git.statusAvailable, true);
    assert.equal(healthyProject?.git.changeCount, 0);
    assert.equal(slowProject?.git.statusAvailable, false);
    assert.equal(slowProject?.git.statusReason, "timeout");
    assert.equal(slowProject?.git.hasCommits, true);
  } finally {
    if (oldRoot === undefined) delete process.env.GIT_SCAN_ROOT; else process.env.GIT_SCAN_ROOT = oldRoot;
    if (oldGithub === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB; else process.env.GIT_SCAN_DISABLE_GITHUB = oldGithub;
    if (oldTimeout === undefined) delete process.env.GIT_SCAN_STATUS_TIMEOUT_MS; else process.env.GIT_SCAN_STATUS_TIMEOUT_MS = oldTimeout;
    await rm(root, { recursive: true, force: true });
  }
});

test("sync comparison classifies local and remote refs reproducibly", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "project-sync-matrix-test-"));
  const remote = path.join(temp, "remote.git");
  const local = path.join(temp, "local");
  const peer = path.join(temp, "peer");
  try {
    await mkdir(local);
    execFileSync("git", ["init", "--bare", remote]);
    execFileSync("git", ["init", "-b", "main"], { cwd: local });
    execFileSync("git", ["config", "user.name", "Project Deck Test"], { cwd: local });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: local });
    await writeFile(path.join(local, "README.md"), "initial\n");
    execFileSync("git", ["add", "README.md"], { cwd: local });
    execFileSync("git", ["commit", "-m", "Initial"], { cwd: local });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: local });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: local });
    assert.equal((await getSyncState(local, "main", true, true, false)).state, "in_sync");

    await writeFile(path.join(local, "local.txt"), "ahead\n");
    execFileSync("git", ["add", "local.txt"], { cwd: local });
    execFileSync("git", ["commit", "-m", "Local ahead"], { cwd: local });
    const ahead = await getSyncState(local, "main", true, true, false);
    assert.deepEqual({ state: ahead.state, ahead: ahead.ahead, behind: ahead.behind }, { state: "ahead", ahead: 1, behind: 0 });

    execFileSync("git", ["reset", "--hard", "origin/main"], { cwd: local });
    execFileSync("git", ["clone", "-b", "main", remote, peer]);
    execFileSync("git", ["config", "user.name", "Project Deck Test"], { cwd: peer });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: peer });
    await writeFile(path.join(peer, "remote.txt"), "behind\n");
    execFileSync("git", ["add", "remote.txt"], { cwd: peer });
    execFileSync("git", ["commit", "-m", "Remote ahead"], { cwd: peer });
    execFileSync("git", ["push", "origin", "main"], { cwd: peer });
    execFileSync("git", ["fetch", "origin"], { cwd: local });
    const behind = await getSyncState(local, "main", true, true, false);
    assert.deepEqual({ state: behind.state, ahead: behind.ahead, behind: behind.behind }, { state: "behind", ahead: 0, behind: 1 });

    await writeFile(path.join(local, "diverged.txt"), "diverged\n");
    execFileSync("git", ["add", "diverged.txt"], { cwd: local });
    execFileSync("git", ["commit", "-m", "Diverged local"], { cwd: local });
    const diverged = await getSyncState(local, "main", true, true, false);
    assert.deepEqual({ state: diverged.state, ahead: diverged.ahead, behind: diverged.behind }, { state: "diverged", ahead: 1, behind: 1 });

    execFileSync("git", ["checkout", "-b", "feature"], { cwd: local });
    assert.equal((await getSyncState(local, "feature", true, true, false)).state, "unpublished");
    assert.equal((await getSyncState(local, "feature", false, true, false)).state, "no_commits");
    assert.equal((await getSyncState(local, "feature", true, false, false)).state, "no_remote");
    assert.equal((await getSyncState(local, null, true, true, false)).state, "unavailable");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("measures nested and hidden regular files while assigning symlinks zero bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-size-test-"));
  const outside = await mkdtemp(path.join(tmpdir(), "project-size-outside-"));
  try {
    await mkdir(path.join(root, ".git", "objects"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "visible"), "12345");
    await writeFile(path.join(root, ".hidden"), "123");
    await writeFile(path.join(root, ".git", "objects", "object"), "1234567");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "12345678901");
    await writeFile(path.join(outside, "huge"), "x".repeat(10_000));
    await symlink(outside, path.join(root, "outside-link"));
    await symlink(root, path.join(root, "loop"));
    assert.deepEqual(await measureProjectSize(root), { status: "complete", bytes: 26 });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("skips ENOENT races but sanitizes fatal measurement failures", async () => {
  const fakeEntries = [{ name: "gone", isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }];
  const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
  const raced = await measureProjectSize("/private/fixture", {
    readdir: async () => fakeEntries,
    lstat: async () => { throw enoent; },
  } as never);
  assert.deepEqual(raced, { status: "complete", bytes: 0 });
  assert.deepEqual(Object.keys(raced).sort(), ["bytes", "status"]);

  const denied = await measureProjectSize("/private/fixture", {
    readdir: async () => { throw Object.assign(new Error("secret /private/fixture"), { code: "EACCES" }); },
    lstat: async () => { throw new Error("unused"); },
  } as never);
  assert.deepEqual(denied, {
    status: "error",
    code: "measurement_failed",
    message: "Size unavailable because part of this folder could not be read.",
  });
  assert.deepEqual(Object.keys(denied).sort(), ["code", "message", "status"]);
  assert.equal("bytes" in denied, false);
  assert.doesNotMatch(JSON.stringify(denied), /private|secret|EACCES/u);
});

test("serializes only the frozen public project-size API keys", async () => {
  const complete = await measureProjectSize("/fixture", {
    readdir: async () => [], lstat: async () => { throw new Error("unused"); },
  } as never);
  const sensitive = "/Users/private/customer/project/.secret: permission denied";
  const failed = await measureProjectSize("/fixture", {
    readdir: async () => { throw Object.assign(new Error(sensitive), { code: "EPERM", stack: sensitive }); },
    lstat: async () => { throw new Error("unused"); },
  } as never);
  const response = JSON.parse(JSON.stringify({ projects: [{ size: complete }, { size: failed }] }));
  assert.deepEqual(response.projects[0].size, { status: "complete", bytes: 0 });
  assert.deepEqual(response.projects[1].size, {
    status: "error", code: "measurement_failed",
    message: "Size unavailable because part of this folder could not be read.",
  });
  assert.doesNotMatch(JSON.stringify(response), /Users|private|customer|\.secret|permission denied|EPERM/u);
});

test("formats byte boundaries without unstable units", () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"], [1, "1 B"], [1023, "1023 B"], [1024, "1 KB"],
    [1536, "1.5 KB"], [1024 ** 2 - 1, "1 MB"], [1024 ** 2, "1 MB"],
    [1024 ** 3 - 1, "1 GB"], [1024 ** 3, "1 GB"],
    [1024 ** 4 - 1, "1 TB"], [1024 ** 4, "1 TB"],
    [Number.MAX_SAFE_INTEGER, "8192 TB"],
  ];
  for (const [bytes, expected] of cases) assert.equal(formatProjectSize(bytes), expected);
  assert.equal(formatProjectSize(Number.NaN), "Unavailable");
  assert.equal(formatProjectSize(Number.POSITIVE_INFINITY), "Unavailable");
  assert.equal(formatProjectSize(-1), "Unavailable");
});

test("discovers overview prose before manifests and reports exact provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-description-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "---\ntitle: ignored\n---\n\n# Heading\n\n[![badge](badge.svg)](https://example.test)\n\nThis README paragraph explains the project in enough useful detail.\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ description: "This manifest description should lose to the overview prose." }));
    const description = await discoverProjectDescription(root, ["package.json", "README.md"]);
    assert.equal(description.text, "This README paragraph explains the project in enough useful detail.");
    assert.equal(description.sourceLabel, "From README.md");
    const edited = await discoverProjectDescription(root, ["package.json", "README.md"], "A private Project Deck override with four useful words.");
    assert.equal(edited.source, "local");
    assert.equal(edited.sourceLabel, "Edited in Project Deck");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("falls through malformed sources to ordered project manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-manifest-description-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "# Heading only\n");
    await writeFile(path.join(root, "package.json"), "not json");
    await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\ndescription = \"A Python project description with enough useful local detail.\"\n\n[tool.poetry]\ndescription = \"This lower-priority value should not win.\"\n");
    const description = await discoverProjectDescription(root, ["README.md", "package.json", "pyproject.toml"]);
    assert.equal(description.text, "A Python project description with enough useful local detail.");
    assert.equal(description.sourceLabel, "From pyproject.toml");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("description acceptance and truncation use frozen code-point boundaries", () => {
  assert.equal(descriptionFromOverview("one two abcdefghijklmnop"), null);
  assert.equal(descriptionFromOverview("one two three four 123456"), "one two three four 123456");
  assert.equal(Array.from(compactDescription("🙂".repeat(181))).length, 180);
  assert.equal(compactDescription("🙂".repeat(181)).endsWith("…"), true);
});

test("persists path-scoped project intent without same-name root collisions", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "project-preferences-test-"));
  const rootA = path.join(temp, "a"); const rootB = path.join(temp, "b"); const settingsPath = path.join(temp, "settings.json");
  const oldRoot = process.env.GIT_SCAN_ROOT; const oldSettings = process.env.GIT_SCAN_SETTINGS_PATH; const oldGithub = process.env.GIT_SCAN_DISABLE_GITHUB;
  process.env.GIT_SCAN_SETTINGS_PATH = settingsPath; process.env.GIT_SCAN_DISABLE_GITHUB = "1";
  try {
    await mkdir(path.join(rootA, "atlas"), { recursive: true }); await mkdir(path.join(rootB, "atlas"), { recursive: true });
    await writeFile(path.join(rootA, "atlas", "README.md"), "Atlas A is a useful local project with clear descriptive prose.\n");
    await writeFile(path.join(rootB, "atlas", "README.md"), "Atlas B is another useful project with different descriptive prose.\n");
    process.env.GIT_SCAN_ROOT = rootA; await loadProjectsRoot(); await setProjectPreferences("atlas", { ignored: true, description: "A private description saved only for Atlas A." });
    assert.equal((await scanProjects()).projects[0].preferences.ignored, true);
    assert.equal((await scanProjects()).projects[0].description.source, "local");
    process.env.GIT_SCAN_ROOT = rootB; await loadProjectsRoot();
    const b = (await scanProjects()).projects[0]; assert.equal(b.preferences.ignored, false); assert.equal(b.description.source, "file");
    await setProjectPreferences("atlas", { localOnly: true });
    process.env.GIT_SCAN_ROOT = rootA; await loadProjectsRoot();
    const a = (await scanProjects()).projects[0]; assert.deepEqual(a.preferences, { ignored: true, localOnly: false });
  } finally {
    if (oldRoot === undefined) delete process.env.GIT_SCAN_ROOT; else process.env.GIT_SCAN_ROOT = oldRoot;
    if (oldSettings === undefined) delete process.env.GIT_SCAN_SETTINGS_PATH; else process.env.GIT_SCAN_SETTINGS_PATH = oldSettings;
    if (oldGithub === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB; else process.env.GIT_SCAN_DISABLE_GITHUB = oldGithub;
    await rm(temp, { recursive: true, force: true });
  }
});

test("canonical paths unify symlink aliases for existing projects", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "project-path-test-"));
  try {
    const real = path.join(temp, "real"); const alias = path.join(temp, "alias"); await mkdir(real); await symlink(real, alias);
    assert.equal(await canonicalizeProjectPath(`${alias}/`), await canonicalizeProjectPath(real));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("server-side local-only intent blocks every GitHub mutation while allowing local Git initialization", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "project-local-only-action-test-"));
  const root = path.join(temp, "root"); const settingsPath = path.join(temp, "settings.json");
  const oldRoot = process.env.GIT_SCAN_ROOT; const oldSettings = process.env.GIT_SCAN_SETTINGS_PATH; const oldGithub = process.env.GIT_SCAN_DISABLE_GITHUB;
  process.env.GIT_SCAN_ROOT = root; process.env.GIT_SCAN_SETTINGS_PATH = settingsPath; process.env.GIT_SCAN_DISABLE_GITHUB = "1";
  try {
    await mkdir(path.join(root, "atlas"), { recursive: true });
    await writeFile(path.join(root, "atlas", "README.md"), "Atlas is a useful local-only project for action guard testing.\n");
    await loadProjectsRoot();
    await setProjectPreferences("atlas", { localOnly: true });
    const initialized = await initializeProject("atlas");
    assert.equal(initialized.project.git.isRepository, true);
    for (const operation of [
      () => linkMatchedRepository("atlas"),
      () => createGithubRepository("atlas", "private"),
      () => commitAndPushProject("atlas", "Initial commit"),
    ]) {
      await assert.rejects(operation, (error: unknown) => error instanceof ProjectActionError && error.code === "local_only" && /atlas is marked Local only/u.test(error.message));
    }
  } finally {
    if (oldRoot === undefined) delete process.env.GIT_SCAN_ROOT; else process.env.GIT_SCAN_ROOT = oldRoot;
    if (oldSettings === undefined) delete process.env.GIT_SCAN_SETTINGS_PATH; else process.env.GIT_SCAN_SETTINGS_PATH = oldSettings;
    if (oldGithub === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB; else process.env.GIT_SCAN_DISABLE_GITHUB = oldGithub;
    await rm(temp, { recursive: true, force: true });
  }
});

function actionFixture(name: string, patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    name, canonicalPath: `/tmp/${name}`, pathLabel: `~/tmp/${name}`,
    description: { text: "Action fixture.", compact: "Action fixture.", source: "file", sourceLabel: "From README.md", sourceFile: "README.md" },
    summary: "Action fixture.", preferences: { ignored: false, localOnly: false }, technologies: [], modifiedAt: "2026-01-01T00:00:00.000Z",
    size: { status: "complete", bytes: 1 },
    git: { isRepository: true, branch: "main", hasCommits: true, changeCount: 0, statusAvailable: true, lastCommitAt: null, lastCommitMessage: null },
    github: { state: "linked", repository: { name, nameWithOwner: `person/${name}`, url: `https://github.com/person/${name}`, isPrivate: true } },
    sync: { state: "unpublished", ahead: 1, behind: 0, checkedRemote: true, detail: "Not pushed." },
    ...patch,
  };
}

test("initial commit push failure reports partial truth and a retry never repeats the commit", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "project-initial-push-test-")); const root = path.join(temp, "root"); const projectPath = path.join(root, "atlas");
  const oldRoot = process.env.GIT_SCAN_ROOT; const oldSettings = process.env.GIT_SCAN_SETTINGS_PATH; const oldGithub = process.env.GIT_SCAN_DISABLE_GITHUB;
  process.env.GIT_SCAN_ROOT = root; process.env.GIT_SCAN_SETTINGS_PATH = path.join(temp, "settings.json"); process.env.GIT_SCAN_DISABLE_GITHUB = "1";
  try {
    await mkdir(path.join(projectPath, ".git"), { recursive: true }); await loadProjectsRoot();
    const calls: string[] = [];
    const execute = async (_command: string, args: string[]) => {
      const key = args.join(" "); calls.push(key);
      if (key === "remote get-url origin") return { ok: true, stdout: "https://github.com/person/atlas.git", stderr: "", exitCode: 0 };
      if (key === "branch --show-current") return { ok: true, stdout: "main", stderr: "", exitCode: 0 };
      if (key === "ls-files --others --exclude-standard") return { ok: true, stdout: "file.txt", stderr: "", exitCode: 0 };
      if (key === "show-ref --verify refs/remotes/origin/main") return { ok: false, stdout: "", stderr: "", exitCode: 1 };
      if (key === "status --porcelain") return { ok: true, stdout: "?? file.txt", stderr: "", exitCode: 0 };
      if (key === "rev-parse HEAD") return { ok: false, stdout: "", stderr: "", exitCode: 128 };
      if (key === "push -u origin main") return { ok: false, stdout: "", stderr: "remote unavailable", exitCode: 1 };
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    };
    await assert.rejects(
      () => commitAndPushProject("atlas", "Initial commit", { execute, refresh: async () => actionFixture("atlas") }),
      (error: unknown) => error instanceof ProjectActionError && error.code === "initial_push_failed" && error.message.startsWith("Initial commit created locally, but push failed") && error.project?.git.hasCommits === true,
    );
    assert.equal(calls.filter((call) => call.startsWith("commit ")).length, 1);
    assert.equal(calls.filter((call) => call.startsWith("push ")).length, 1);

    const retryCalls: string[] = [];
    const retry = async (_command: string, args: string[]) => {
      const key = args.join(" "); retryCalls.push(key);
      if (key === "remote get-url origin") return { ok: true, stdout: "https://github.com/person/atlas.git", stderr: "", exitCode: 0 };
      if (key === "branch --show-current") return { ok: true, stdout: "main", stderr: "", exitCode: 0 };
      if (key === "show-ref --verify refs/remotes/origin/main") return { ok: false, stdout: "", stderr: "", exitCode: 1 };
      if (key === "rev-parse HEAD") return { ok: true, stdout: "abc123", stderr: "", exitCode: 0 };
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await commitAndPushProject("atlas", "", { execute: retry, refresh: async () => actionFixture("atlas", { sync: { state: "in_sync", ahead: 0, behind: 0, checkedRemote: true, detail: "In sync." } }) });
    assert.equal(result.message, "Pushed local commits to GitHub.");
    assert.equal(retryCalls.some((call) => call.startsWith("commit ")), false);
    assert.equal(retryCalls.filter((call) => call.startsWith("push ")).length, 1);
  } finally {
    if (oldRoot === undefined) delete process.env.GIT_SCAN_ROOT; else process.env.GIT_SCAN_ROOT = oldRoot;
    if (oldSettings === undefined) delete process.env.GIT_SCAN_SETTINGS_PATH; else process.env.GIT_SCAN_SETTINGS_PATH = oldSettings;
    if (oldGithub === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB; else process.env.GIT_SCAN_DISABLE_GITHUB = oldGithub;
    await rm(temp, { recursive: true, force: true });
  }
});

test("empty initial commit and pre-push failure boundaries are deterministic", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "project-empty-commit-test-")); const root = path.join(temp, "root"); const projectPath = path.join(root, "atlas");
  const oldRoot = process.env.GIT_SCAN_ROOT; const oldSettings = process.env.GIT_SCAN_SETTINGS_PATH; const oldGithub = process.env.GIT_SCAN_DISABLE_GITHUB;
  process.env.GIT_SCAN_ROOT = root; process.env.GIT_SCAN_SETTINGS_PATH = path.join(temp, "settings.json"); process.env.GIT_SCAN_DISABLE_GITHUB = "1";
  try {
    await mkdir(path.join(projectPath, ".git"), { recursive: true }); await loadProjectsRoot();
    const calls: string[] = [];
    const execute = async (_command: string, args: string[]) => {
      const key = args.join(" "); calls.push(key);
      if (key === "remote get-url origin") return { ok: true, stdout: "https://github.com/person/atlas.git", stderr: "", exitCode: 0 };
      if (key === "branch --show-current") return { ok: true, stdout: "main", stderr: "", exitCode: 0 };
      if (key === "show-ref --verify refs/remotes/origin/main") return { ok: false, stdout: "", stderr: "", exitCode: 1 };
      if (key === "rev-parse HEAD") return { ok: false, stdout: "", stderr: "", exitCode: 128 };
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await commitAndPushProject("atlas", "Empty baseline", { execute, refresh: async () => actionFixture("atlas") });
    assert.equal(result.message, "Empty initial commit created and pushed to GitHub.");
    assert.equal(calls.includes("commit --allow-empty -m Empty baseline"), true);

    const noMessageCalls: string[] = [];
    const noMessage = async (_command: string, args: string[]) => {
      const key = args.join(" "); noMessageCalls.push(key);
      if (key === "remote get-url origin") return { ok: true, stdout: "https://github.com/person/atlas.git", stderr: "", exitCode: 0 };
      if (key === "branch --show-current") return { ok: true, stdout: "main", stderr: "", exitCode: 0 };
      if (key === "show-ref --verify refs/remotes/origin/main") return { ok: false, stdout: "", stderr: "", exitCode: 1 };
      if (key === "status --porcelain") return { ok: true, stdout: " M file.txt", stderr: "", exitCode: 0 };
      if (key === "rev-parse HEAD") return { ok: true, stdout: "abc123", stderr: "", exitCode: 0 };
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    };
    await assert.rejects(() => commitAndPushProject("atlas", " ", { execute: noMessage }), (error: unknown) => error instanceof ProjectActionError && error.code === "commit_message_required");
    assert.equal(noMessageCalls.some((call) => call.startsWith("git add") || call.startsWith("add ") || call.startsWith("push ")), false);
  } finally {
    if (oldRoot === undefined) delete process.env.GIT_SCAN_ROOT; else process.env.GIT_SCAN_ROOT = oldRoot;
    if (oldSettings === undefined) delete process.env.GIT_SCAN_SETTINGS_PATH; else process.env.GIT_SCAN_SETTINGS_PATH = oldSettings;
    if (oldGithub === undefined) delete process.env.GIT_SCAN_DISABLE_GITHUB; else process.env.GIT_SCAN_DISABLE_GITHUB = oldGithub;
    await rm(temp, { recursive: true, force: true });
  }
});
