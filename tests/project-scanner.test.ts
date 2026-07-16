import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initializeProject, scanProjects } from "../server/project-scanner";
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
