import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GithubRepository,
  ProjectDescription,
  ProjectRecord,
  ProjectScanResponse,
  SyncState,
  ProjectSize,
} from "../lib/project-types";

const execFileAsync = promisify(execFile);
const DEFAULT_ROOT = path.join(homedir(), "Documents");
const COMMAND_TIMEOUT_MS = 1_500;
const MAX_SUMMARY_LENGTH = 180;
const GITHUB_CACHE_MS = 60_000;
const SIZE_ERROR: ProjectSize = {
  status: "error",
  code: "measurement_failed",
  message: "Size unavailable because part of this folder could not be read.",
};

type StoredProjectPreference = {
  ignored?: boolean;
  localOnly?: boolean;
  description?: string;
};

type StoredSettings = {
  version: 1;
  root: string;
  projects: Record<string, StoredProjectPreference>;
};

function settingsPath() {
  return process.env.GIT_SCAN_SETTINGS_PATH || path.join(process.cwd(), ".git-scan-settings.json");
}

let settings: StoredSettings = {
  version: 1,
  root: path.resolve(process.env.GIT_SCAN_ROOT || DEFAULT_ROOT),
  projects: {},
};

type SizeFs = Pick<typeof import("node:fs/promises"), "readdir" | "lstat">;

/** Sum regular-file bytes without following links. ENOENT is a benign scan race. */
export async function measureProjectSize(
  projectPath: string,
  io: SizeFs = { readdir, lstat },
): Promise<ProjectSize> {
  let bytes = 0;
  const pending = [projectPath];
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      let entries;
      try {
        entries = await io.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        let entryStat;
        try {
          entryStat = await io.lstat(entryPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (entryStat.isSymbolicLink()) continue;
        if (entryStat.isDirectory()) pending.push(entryPath);
        else if (entryStat.isFile()) bytes += entryStat.size;
        if (!Number.isSafeInteger(bytes)) throw new Error("Project size exceeds safe integer range");
      }
    }
    return { status: "complete", bytes };
  } catch {
    return { ...SIZE_ERROR };
  }
}

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type GithubContext = {
  available: boolean;
  login: string | null;
  repositories: GithubRepository[];
  byName: Map<string, GithubRepository>;
  byFullName: Map<string, GithubRepository>;
};

let githubContextCache: { createdAt: number; value: GithubContext } | null = null;
let githubContextInFlight: Promise<GithubContext> | null = null;
let githubLoginInFlight: Promise<{ code: string; verificationUrl: string }> | null = null;

export class ProjectActionError extends Error {
  status: number;
  code: string | null;
  project: ProjectRecord | null;

  constructor(message: string, status = 400, details: { code?: string; project?: ProjectRecord } = {}) {
    super(message);
    this.name = "ProjectActionError";
    this.status = status;
    this.code = details.code || null;
    this.project = details.project || null;
  }
}

export async function getGithubAuthentication() {
  const root = getProjectsRoot();
  const version = await run("gh", ["--version"], root, 1_500);
  if (!version.ok) return { cliAvailable: false, connected: false, login: null };
  const user = await run("gh", ["api", "user", "--jq", ".login"], root, 4_000);
  return {
    cliAvailable: true,
    connected: user.ok && Boolean(user.stdout),
    login: user.ok && user.stdout ? user.stdout : null,
  };
}

export function clearGithubContextCache() {
  githubContextCache = null;
  githubContextInFlight = null;
}

export async function startGithubAuthentication() {
  const current = await getGithubAuthentication();
  if (current.connected) return { ...current, code: null, verificationUrl: null };
  if (!current.cliAvailable) {
    throw new ProjectActionError(
      "Install GitHub CLI first, then return here to connect your account.",
      501,
    );
  }
  githubLoginInFlight ??= new Promise((resolve, reject) => {
    const child = spawn("gh", ["auth", "login", "-h", "github.com", "-p", "https", "-w"], {
      cwd: getProjectsRoot(),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: "pipe",
    });
    let output = "";
    let delivered = false;
    const inspect = (chunk: Buffer | string) => {
      output += chunk.toString().replace(/\u001b\[[0-9;]*m/gu, "");
      const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/u)?.[0];
      if (!code || delivered) return;
      delivered = true;
      child.stdin.write("\n");
      resolve({ code, verificationUrl: "https://github.com/login/device" });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("error", () => reject(new ProjectActionError("GitHub CLI could not start.", 500)));
    child.on("exit", () => {
      githubLoginInFlight = null;
      if (!delivered) {
        reject(new ProjectActionError("GitHub sign-in could not be started.", 500));
      }
    });
  });
  return githubLoginInFlight;
}

let selectedProjectsRoot = path.resolve(process.env.GIT_SCAN_ROOT || DEFAULT_ROOT);

function expandHome(value: string) {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export async function canonicalizeProjectPath(value: string) {
  const resolved = path.resolve(expandHome(value));
  try {
    return await realpath(resolved);
  } catch {
    return resolved === path.parse(resolved).root ? resolved : resolved.replace(/[\\/]+$/u, "");
  }
}

async function validateProjectsRoot(value: string) {
  const resolved = await canonicalizeProjectPath(value);
  let rootStat;
  try {
    rootStat = await stat(resolved);
  } catch {
    throw new ProjectActionError("That folder could not be found or opened.", 400);
  }
  if (!rootStat.isDirectory()) {
    throw new ProjectActionError("Choose a folder, not a file.", 400);
  }
  return resolved;
}

export async function loadProjectsRoot() {
  if (process.env.GIT_SCAN_ROOT) selectedProjectsRoot = await validateProjectsRoot(process.env.GIT_SCAN_ROOT);
  settings = { version: 1, root: selectedProjectsRoot, projects: {} };
  try {
    const saved = JSON.parse(await readFile(settingsPath(), "utf8")) as Partial<StoredSettings>;
    if (saved.version === 1) {
      if (!process.env.GIT_SCAN_ROOT && typeof saved.root === "string") {
        selectedProjectsRoot = await validateProjectsRoot(saved.root);
      }
      const projects = saved.projects && typeof saved.projects === "object" && !Array.isArray(saved.projects)
        ? Object.fromEntries(Object.entries(saved.projects).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value)))
        : {};
      settings = { version: 1, root: selectedProjectsRoot, projects };
    }
  } catch {
    // Missing, stale, or malformed local preferences fall back to ~/Documents.
  }
  return selectedProjectsRoot;
}

export async function setProjectsRoot(value: string) {
  const requestedRoot = path.resolve(expandHome(value));
  const currentRoot = getProjectsRoot();
  if (requestedRoot === currentRoot) return currentRoot;
  const nextRoot = await validateProjectsRoot(value);
  if (nextRoot === selectedProjectsRoot) return selectedProjectsRoot;
  selectedProjectsRoot = nextRoot;
  settings = { ...settings, root: selectedProjectsRoot };
  await persistSettings();
  return selectedProjectsRoot;
}

async function persistSettings() {
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function preferenceFor(canonicalPath: string) {
  const stored = settings.projects[canonicalPath] || {};
  return {
    ignored: stored.ignored === true,
    localOnly: stored.localOnly === true,
    description: typeof stored.description === "string" && stored.description.trim()
      ? stored.description.trim()
      : null,
  };
}

function assertGithubActionAllowed(name: string, canonicalPath: string, action: string) {
  if (!preferenceFor(canonicalPath).localOnly) return;
  throw new ProjectActionError(
    `${name} is marked Local only. Choose Allow GitHub before ${action}. No repository action was run.`,
    409,
    { code: "local_only" },
  );
}

export async function chooseProjectsRoot() {
  if (platform() !== "darwin") {
    throw new ProjectActionError(
      "Native folder browsing is not available here. Enter the folder path instead.",
      501,
    );
  }
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Choose the parent folder containing your projects")'],
      { encoding: "utf8", timeout: 120_000 },
    );
    return setProjectsRoot(stdout.trim());
  } catch {
    throw new ProjectActionError("Folder selection was cancelled.", 409);
  }
}

export function getProjectsRoot() {
  return path.resolve(process.env.GIT_SCAN_ROOT || selectedProjectsRoot);
}

export async function openProjectsRoot() {
  const root = getProjectsRoot();
  const system = platform();
  const command = system === "darwin" ? "open" : system === "win32" ? "explorer" : "xdg-open";
  try {
    await execFileAsync(command, [root], { encoding: "utf8", timeout: 5_000 });
  } catch {
    throw new ProjectActionError("The selected folder could not be opened in the system file browser.", 500);
  }
  return root;
}

function rootLabel(root: string) {
  const home = homedir();
  return root.startsWith(home) ? `~${root.slice(home.length)}` : root;
}

async function exists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number, fallback: T) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };

    return {
      ok: false,
      stdout: String(commandError.stdout || "").trim(),
      stderr: String(commandError.stderr || commandError.message || "").trim(),
      exitCode:
        typeof commandError.code === "number" ? commandError.code : null,
    };
  }
}

/**
 * Use macOS' native directory walker for the real Documents inventory. It is
 * dramatically faster on large dependency trees than issuing one JavaScript
 * lstat call per file. Custom/test roots retain the exact logical-byte walker
 * above so its deterministic semantics remain available and fully tested.
 */
async function measureProjectSizeForScan(projectPath: string, root: string) {
  if (root !== DEFAULT_ROOT || process.env.GIT_SCAN_USE_NATIVE_SIZE === "0") {
    return measureProjectSize(projectPath);
  }

  // One cloud-backed or unavailable folder must not hold the complete ledger.
  const result = await run("du", ["-sk", projectPath], root, 12_000);
  if (!result.ok) return { ...SIZE_ERROR };
  const kibibytes = Number.parseInt(result.stdout.split(/\s+/u)[0] || "", 10);
  const bytes = kibibytes * 1024;
  return Number.isSafeInteger(bytes) && bytes >= 0
    ? ({ status: "complete", bytes } satisfies ProjectSize)
    : { ...SIZE_ERROR };
}

async function measureProjectSizesForRoot(root: string, folderNames: string[]) {
  const sizes = new Map<string, ProjectSize>();
  if (root !== DEFAULT_ROOT || process.env.GIT_SCAN_USE_NATIVE_SIZE === "0") {
    const measured = await mapWithConcurrency(folderNames, 16, async (name) => [
      name,
      await measureProjectSize(path.join(root, name)),
    ] as const);
    for (const [name, size] of measured) sizes.set(name, size);
    return sizes;
  }

  const projectPaths = folderNames.map((name) => path.join(root, name));
  const result = await run("du", ["-sk", ...projectPaths], root, 30_000);
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^(\d+)\s+(.+)$/u);
    if (!match) continue;
    const folderPath = path.resolve(match[2]);
    const name = path.basename(folderPath);
    const bytes = Number.parseInt(match[1], 10) * 1024;
    if (folderNames.includes(name) && Number.isSafeInteger(bytes)) {
      sizes.set(name, { status: "complete", bytes });
    }
  }
  for (const name of folderNames) {
    if (!sizes.has(name)) sizes.set(name, { ...SIZE_ERROR });
  }
  return sizes;
}

function friendlyCommandError(result: CommandResult, fallback: string) {
  const lastLine = (result.stderr || result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  return lastLine || fallback;
}

export function cleanDescription(value: string) {
  return value
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[`*_~>#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function compactDescription(value: string, maxLength = MAX_SUMMARY_LENGTH) {
  const points = Array.from(value);
  return points.length <= maxLength ? value : `${points.slice(0, maxLength - 1).join("")}…`;
}

function acceptedDescription(value: string) {
  const cleaned = cleanDescription(value);
  const words = cleaned.match(/[\p{L}\p{N}]+/gu) || [];
  return Array.from(cleaned).length >= 24 && words.length >= 4 ? cleaned : null;
}

export function descriptionFromOverview(contents: string) {
  const withoutNoise = contents
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, " ");
  const paragraphs = withoutNoise.split(/\n\s*\n/u);

  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every((line) =>
      /^#{1,6}\s|^!\[|^\[[^\]]*\](?:\([^)]*\))?$|^[-*+]\s*$|^\|.*\|$|^\s*[-:| ]+\s*$/u.test(line)
    )) continue;
    const accepted = acceptedDescription(lines.join(" "));
    if (accepted) return accepted;
  }

  return null;
}

function winningName(names: string[], slot: string) {
  if (names.includes(slot)) return slot;
  return names.filter((name) => name.toLowerCase() === slot.toLowerCase()).sort()[0] || null;
}

async function readPrefix(filePath: string, bytes = 64 * 1024) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function fileDescription(text: string, file: string): ProjectDescription {
  return {
    text,
    compact: compactDescription(text),
    source: "file",
    sourceLabel: `From ${file}`,
    sourceFile: file,
  };
}

function tomlDescription(contents: string, section: string) {
  let active = false;
  for (const line of contents.split(/\r?\n/u)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/u)?.[1];
    if (heading) {
      if (active) return null;
      active = heading === section;
      continue;
    }
    if (!active) continue;
    const description = line.match(/^\s*description\s*=\s*["'](.+?)["']\s*$/u)?.[1];
    if (description) return description;
  }
  return null;
}

export async function discoverProjectDescription(projectPath: string, names: string[], localOverride: string | null = null): Promise<ProjectDescription> {
  if (localOverride) {
    const text = cleanDescription(localOverride);
    if (text) return { text, compact: compactDescription(text), source: "local", sourceLabel: "Edited in Project Deck", sourceFile: null };
  }

  for (const slot of ["README.md", "README", "README.rst", "README.txt", "ABOUT.md", "OVERVIEW.md"]) {
    const file = winningName(names, slot);
    if (!file) continue;
    try {
      const description = descriptionFromOverview(await readPrefix(path.join(projectPath, file)));
      if (description) return fileDescription(description, file);
    } catch {
      // Deterministically fall through to the next source.
    }
  }

  const packageFile = winningName(names, "package.json");
  if (packageFile) {
    try {
      const packageJson = JSON.parse(
        await readFile(path.join(projectPath, packageFile), "utf8"),
      ) as { description?: unknown };
      const description = typeof packageJson.description === "string" ? acceptedDescription(packageJson.description) : null;
      if (description) return fileDescription(description, packageFile);
    } catch {
      // Fall through to other project metadata.
    }
  }

  const pyproject = winningName(names, "pyproject.toml");
  if (pyproject) {
    try {
      const contents = await readFile(path.join(projectPath, pyproject), "utf8");
      for (const section of ["project", "tool.poetry"]) {
        const description = acceptedDescription(tomlDescription(contents, section) || "");
        if (description) return fileDescription(description, pyproject);
      }
    } catch {
      // Fall through to Cargo metadata.
    }
  }

  const cargoFile = winningName(names, "Cargo.toml");
  if (cargoFile) {
    try {
      const contents = await readFile(path.join(projectPath, cargoFile), "utf8");
      const description = acceptedDescription(tomlDescription(contents, "package") || "");
      if (description) return fileDescription(description, cargoFile);
    } catch {
      // A missing description is a valid project state.
    }
  }

  return { text: "", compact: "", source: "none", sourceLabel: "No suitable local description found", sourceFile: null };
}

async function discoverProjectDescriptionWithCommands(
  root: string,
  projectPath: string,
  names: string[],
  localOverride: string | null,
): Promise<ProjectDescription> {
  if (localOverride) {
    const text = cleanDescription(localOverride);
    if (text) return { text, compact: compactDescription(text), source: "local", sourceLabel: "Edited in Project Deck", sourceFile: null };
  }

  const readBounded = async (file: string) => {
    const result = await run("head", ["-c", "65536", path.join(projectPath, file)], root, 1_200);
    return result.stdout;
  };

  for (const slot of ["README.md", "README", "README.rst", "README.txt", "ABOUT.md", "OVERVIEW.md"]) {
    const file = winningName(names, slot);
    if (!file) continue;
    const description = descriptionFromOverview(await readBounded(file));
    if (description) return fileDescription(description, file);
  }

  const packageFile = winningName(names, "package.json");
  if (packageFile) {
    try {
      const packageJson = JSON.parse(await readBounded(packageFile)) as { description?: unknown };
      const description = typeof packageJson.description === "string" ? acceptedDescription(packageJson.description) : null;
      if (description) return fileDescription(description, packageFile);
    } catch {
      // Continue to other metadata sources.
    }
  }

  for (const [slot, sections] of [["pyproject.toml", ["project", "tool.poetry"]], ["Cargo.toml", ["package"]]] as const) {
    const file = winningName(names, slot);
    if (!file) continue;
    const contents = await readBounded(file);
    for (const section of sections) {
      const description = acceptedDescription(tomlDescription(contents, section) || "");
      if (description) return fileDescription(description, file);
    }
  }

  return { text: "", compact: "", source: "none", sourceLabel: "No suitable local description found", sourceFile: null };
}

function detectTechnologies(names: string[]) {
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  const technologies: string[] = [];
  const add = (label: string) => {
    if (!technologies.includes(label)) technologies.push(label);
  };

  if (lowerNames.has("package.json")) add("Node.js");
  if (
    lowerNames.has("pyproject.toml") ||
    lowerNames.has("requirements.txt") ||
    lowerNames.has("pipfile")
  ) {
    add("Python");
  }
  if (lowerNames.has("cargo.toml")) add("Rust");
  if (lowerNames.has("go.mod")) add("Go");
  if (lowerNames.has("package.swift")) add("Swift");
  if (lowerNames.has("gemfile")) add("Ruby");
  if ([...lowerNames].some((name) => name.endsWith(".xcodeproj"))) add("Xcode");
  if (lowerNames.has("dockerfile") || lowerNames.has("docker-compose.yml")) add("Docker");

  return technologies.slice(0, 3);
}

function parseGithubRemote(remote: string) {
  const patterns = [
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/iu,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/iu,
    /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/iu,
  ];

  for (const pattern of patterns) {
    const match = remote.match(pattern);
    if (match) {
      const owner = match[1];
      const repo = match[2].replace(/\.git$/iu, "");
      return {
        owner,
        repo,
        nameWithOwner: `${owner}/${repo}`,
        url: `https://github.com/${owner}/${repo}`,
      };
    }
  }

  return null;
}

async function getGithubContext(root: string): Promise<GithubContext> {
  if (process.env.GIT_SCAN_DISABLE_GITHUB === "1") {
    return {
      available: false,
      login: null,
      repositories: [],
      byName: new Map(),
      byFullName: new Map(),
    };
  }

  if (githubContextCache && Date.now() - githubContextCache.createdAt < GITHUB_CACHE_MS) {
    return githubContextCache.value;
  }
  if (githubContextInFlight) return githubContextInFlight;

  githubContextInFlight = loadGithubContext(root);
  try {
    const value = await githubContextInFlight;
    githubContextCache = { createdAt: Date.now(), value };
    return value;
  } finally {
    githubContextInFlight = null;
  }
}

async function loadGithubContext(root: string): Promise<GithubContext> {
  const user = await run("gh", ["api", "user", "--jq", ".login"], root, 3_000);
  if (!user.ok || !user.stdout) {
    return {
      available: false,
      login: null,
      repositories: [],
      byName: new Map(),
      byFullName: new Map(),
    };
  }

  const repoList = await run(
    "gh",
    [
      "repo",
      "list",
      user.stdout,
      "--limit",
      "1000",
      "--json",
      "name,nameWithOwner,url,isPrivate",
    ],
    root,
    8_000,
  );

  let repositories: GithubRepository[] = [];
  if (repoList.ok) {
    try {
      repositories = JSON.parse(repoList.stdout) as GithubRepository[];
    } catch {
      repositories = [];
    }
  }

  return {
    available: true,
    login: user.stdout,
    repositories,
    byName: new Map(repositories.map((repo) => [repo.name.toLowerCase(), repo])),
    byFullName: new Map(
      repositories.map((repo) => [repo.nameWithOwner.toLowerCase(), repo]),
    ),
  };
}

function syncDetail(
  state: SyncState,
  ahead: number,
  behind: number,
  checkedRemote: boolean,
) {
  const qualifier = checkedRemote ? "" : " based on the last local fetch";
  switch (state) {
    case "in_sync":
      return `Local and GitHub match${qualifier}.`;
    case "ahead":
      return `${ahead} local commit${ahead === 1 ? "" : "s"} ready to push${qualifier}.`;
    case "behind":
      return `${behind} remote commit${behind === 1 ? "" : "s"} need to be pulled${qualifier}.`;
    case "diverged":
      return `Local is ${ahead} ahead and ${behind} behind${qualifier}.`;
    case "unpublished":
      return "This branch has not been pushed to GitHub yet.";
    case "no_remote":
      return "No GitHub remote is linked.";
    case "no_commits":
      return "There are no local commits yet.";
    default:
      return checkedRemote
        ? "GitHub could not be reached for a current comparison."
        : "Sync status is not available.";
  }
}

async function getSyncState(
  projectPath: string,
  branch: string | null,
  hasCommits: boolean,
  hasGithubRemote: boolean,
  refreshRemote: boolean,
) {
  if (!hasGithubRemote) {
    const state: SyncState = "no_remote";
    return { state, ahead: 0, behind: 0, checkedRemote: false, detail: syncDetail(state, 0, 0, false) };
  }

  if (!hasCommits) {
    const state: SyncState = "no_commits";
    return { state, ahead: 0, behind: 0, checkedRemote: false, detail: syncDetail(state, 0, 0, false) };
  }

  if (!branch) {
    const state: SyncState = "unavailable";
    return { state, ahead: 0, behind: 0, checkedRemote: false, detail: "The repository is in a detached HEAD state." };
  }

  let checkedRemote = false;
  if (refreshRemote) {
    const fetched = await run(
      "git",
      ["fetch", "--quiet", "--prune", "origin"],
      projectPath,
      8_000,
    );
    checkedRemote = fetched.ok;
  }

  let comparison = await run(
    "git",
    ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
    projectPath,
  );

  if (!comparison.ok) {
    const upstream = await run(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      projectPath,
    );
    if (upstream.ok) {
      comparison = await run(
        "git",
        ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        projectPath,
      );
    }
  }

  if (!comparison.ok) {
    const remoteBranch = await run(
      "git",
      ["show-ref", "--verify", `refs/remotes/origin/${branch}`],
      projectPath,
    );
    const state: SyncState = remoteBranch.ok ? "unavailable" : "unpublished";
    return {
      state,
      ahead: 0,
      behind: 0,
      checkedRemote,
      detail: syncDetail(state, 0, 0, checkedRemote),
    };
  }

  const [behind = 0, ahead = 0] = comparison.stdout
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10) || 0);
  let state: SyncState = "in_sync";
  if (ahead > 0 && behind > 0) state = "diverged";
  else if (ahead > 0) state = "ahead";
  else if (behind > 0) state = "behind";

  return {
    state,
    ahead,
    behind,
    checkedRemote,
    detail: syncDetail(state, ahead, behind, checkedRemote),
  };
}

async function scanProject(
  root: string,
  name: string,
  github: GithubContext,
  refreshRemote: boolean,
): Promise<ProjectRecord> {
  const projectPath = path.join(root, name);
  const canonicalPath = await canonicalizeProjectPath(projectPath);
  const [entries, projectStat, size] = await Promise.all([
    readdir(projectPath, { withFileTypes: true }).catch(() => []),
    stat(projectPath),
    measureProjectSizeForScan(projectPath, root),
  ]);
  const names = entries.map((entry) => entry.name);
  const projectPreference = preferenceFor(canonicalPath);
  const description = await discoverProjectDescription(projectPath, names, projectPreference.description);
  const technologies = detectTechnologies(names);
  const isRepository = await exists(path.join(projectPath, ".git"));

  if (!isRepository) {
    const matchedRepository = github.byName.get(name.toLowerCase()) || null;
    return {
      name,
      canonicalPath,
      pathLabel: `${rootLabel(root)}/${name}`,
      description,
      summary: description.compact,
      preferences: { ignored: projectPreference.ignored, localOnly: projectPreference.localOnly },
      technologies,
      modifiedAt: projectStat.mtime.toISOString(),
      size,
      git: {
        isRepository: false,
        branch: null,
        hasCommits: false,
        changeCount: 0,
        statusAvailable: true,
        lastCommitAt: null,
        lastCommitMessage: null,
      },
      github: {
        state: matchedRepository ? "matched" : github.available ? "none" : "unavailable",
        repository: matchedRepository,
      },
      sync: {
        state: "no_remote",
        ahead: 0,
        behind: 0,
        checkedRemote: false,
        detail: "Initialize Git before comparing this folder with GitHub.",
      },
    };
  }

  const [branchResult, statusResult, headResult, originResult, lastCommitResult] =
    await Promise.all([
      run("git", ["branch", "--show-current"], projectPath),
      run(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        projectPath,
        1_500,
      ),
      run("git", ["rev-parse", "HEAD"], projectPath),
      run("git", ["remote", "get-url", "origin"], projectPath),
      run(
        "git",
        ["log", "-1", "--format=%cI%x00%s"],
        projectPath,
      ),
    ]);

  const branch = branchResult.ok && branchResult.stdout ? branchResult.stdout : null;
  const hasCommits = headResult.ok;
  const changeCount = statusResult.ok && statusResult.stdout
    ? statusResult.stdout.split("\n").filter(Boolean).length
    : 0;
  const remote = originResult.ok ? parseGithubRemote(originResult.stdout) : null;
  const matched = github.byName.get(name.toLowerCase()) || null;
  const knownLinked = remote
    ? github.byFullName.get(remote.nameWithOwner.toLowerCase()) || null
    : null;
  const linkedRepository = remote
    ? knownLinked || {
        name: remote.repo,
        nameWithOwner: remote.nameWithOwner,
        url: remote.url,
        isPrivate: null,
      }
    : null;
  const lastCommitParts = lastCommitResult.ok
    ? lastCommitResult.stdout.split("\u0000")
    : [];
  const sync = await getSyncState(
    projectPath,
    branch,
    hasCommits,
    Boolean(remote),
    refreshRemote,
  );

  return {
    name,
    canonicalPath,
    pathLabel: `${rootLabel(root)}/${name}`,
    description,
    summary: description.compact,
    preferences: { ignored: projectPreference.ignored, localOnly: projectPreference.localOnly },
    technologies,
    modifiedAt: projectStat.mtime.toISOString(),
    size,
    git: {
      isRepository: true,
      branch,
      hasCommits,
      changeCount,
      statusAvailable: statusResult.ok,
      lastCommitAt: lastCommitParts[0] || null,
      lastCommitMessage: lastCommitParts[1] || null,
    },
    github: {
      state: remote ? "linked" : matched ? "matched" : github.available ? "none" : "unavailable",
      repository: linkedRepository || matched,
    },
    sync,
  };
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
) {
  const results = new Array<U>(values.length);
  let cursor = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(values.length, 1)) },
    async () => {
      while (cursor < values.length) {
        const current = cursor;
        cursor += 1;
        results[current] = await mapper(values[current]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

export async function scanProjects(refreshRemote = false): Promise<ProjectScanResponse> {
  const root = getProjectsRoot();
  const [entries, github] = await Promise.all([
    readdir(root, { withFileTypes: true }),
    getGithubContext(root),
  ]);
  const folderNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  // Most work is independent filesystem/process I/O. A wider bounded pool keeps
  // a large Documents directory responsive while slow folders time out alone.
  const projects = await mapWithConcurrency(folderNames, 32, (name) =>
    scanProject(root, name, github, refreshRemote),
  );

  return {
    rootPath: root,
    rootLabel: rootLabel(root),
    scannedAt: new Date().toISOString(),
    github: {
      available: github.available,
      login: github.login,
    },
    projects,
  };
}

/**
 * Produce the first useful screen without waiting for every Git command. The
 * API serves this inventory immediately while scanProjects enriches it in the
 * background with working-tree, GitHub, and sync details.
 */
export async function scanProjectsQuick(
  includeSizes = false,
  onFacts?: (value: ProjectScanResponse) => void,
): Promise<ProjectScanResponse> {
  const root = getProjectsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const folderNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  if (!includeSizes) {
    const now = new Date().toISOString();
    return {
      rootPath: root,
      rootLabel: rootLabel(root),
      scannedAt: now,
      enriching: true,
      github: { available: false, login: null },
      projects: folderNames.map((name) => {
        const canonicalPath = path.join(root, name);
        const projectPreference = preferenceFor(canonicalPath);
        const description: ProjectDescription = { text: "", compact: "", source: "checking", sourceLabel: "Checking local description…", sourceFile: null };
        return ({
        name, canonicalPath,
        pathLabel: `${rootLabel(root)}/${name}`,
        description,
        summary: "",
        preferences: { ignored: projectPreference.ignored, localOnly: projectPreference.localOnly },
        technologies: [],
        modifiedAt: now,
        size: { ...SIZE_ERROR },
        git: {
          isRepository: false,
          branch: null,
          hasCommits: false,
          changeCount: 0,
          statusAvailable: false,
          lastCommitAt: null,
          lastCommitMessage: null,
        },
        github: { state: "unavailable", repository: null },
        sync: {
          state: "unavailable",
          ahead: 0,
          behind: 0,
          checkedRemote: false,
          detail: "Git and GitHub status are still being checked in the background.",
        },
        transient: { size: "checking", git: "checking", github: "checking", sync: "checking" },
      });}),
    };
  }

  const githubPromise = getGithubContext(root);
  const fastNow = new Date().toISOString();
  const fastProjects = await mapWithConcurrency(folderNames, 12, async (name) => {
    const projectPath = path.join(root, name);
    let gitExists = false;
    let branch: string | null = null;
    let origin = "";
    if (root !== DEFAULT_ROOT || process.env.GIT_SCAN_USE_NATIVE_SIZE === "0") {
      gitExists = await exists(path.join(projectPath, ".git"));
      if (gitExists) {
        const [head, config] = await Promise.all([
          readFile(path.join(projectPath, ".git", "HEAD"), "utf8").catch(() => ""),
          readFile(path.join(projectPath, ".git", "config"), "utf8").catch(() => ""),
        ]);
        const trimmedHead = head.trim();
        branch = trimmedHead.startsWith("ref: refs/heads/") ? trimmedHead.slice("ref: refs/heads/".length) : null;
        origin = config.match(/\[remote "origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/mu)?.[1]?.trim() || "";
      }
    } else {
      const [repositoryResult, branchResult, originResult] = await Promise.all([
        run("git", ["rev-parse", "--is-inside-work-tree"], projectPath, 1_000),
        run("git", ["branch", "--show-current"], projectPath, 1_000),
        run("git", ["remote", "get-url", "origin"], projectPath, 1_000),
      ]);
      gitExists = repositoryResult.ok && repositoryResult.stdout === "true";
      branch = branchResult.ok && branchResult.stdout ? branchResult.stdout : null;
      origin = originResult.ok ? originResult.stdout : "";
    }
    let linkedRepository: GithubRepository | null = null;
    if (gitExists && origin) {
      const parsed = parseGithubRemote(origin);
      if (parsed) linkedRepository = { name: parsed.repo, nameWithOwner: parsed.nameWithOwner, url: parsed.url, isPrivate: null };
    }
    const projectPreference = preferenceFor(projectPath);
    const description: ProjectDescription = { text: "", compact: "", source: "checking", sourceLabel: "Checking local description…", sourceFile: null };
    return {
      name,
      canonicalPath: projectPath,
      pathLabel: `${rootLabel(root)}/${name}`,
      description,
      summary: "",
      preferences: { ignored: projectPreference.ignored, localOnly: projectPreference.localOnly },
      technologies: [],
      modifiedAt: fastNow,
      size: { ...SIZE_ERROR },
      git: { isRepository: gitExists, branch, hasCommits: gitExists, changeCount: 0, statusAvailable: false, lastCommitAt: null, lastCommitMessage: null },
      github: { state: linkedRepository ? "linked" as const : "unavailable" as const, repository: linkedRepository },
      sync: { state: linkedRepository ? "unavailable" as const : "no_remote" as const, ahead: 0, behind: 0, checkedRemote: false, detail: linkedRepository ? "The GitHub remote is linked; detailed sync status is still being checked." : "No GitHub remote is linked." },
      transient: { size: "checking" as const, ...(gitExists ? { git: "checking" as const } : {}), ...(linkedRepository ? { sync: "checking" as const } : {}) },
    } satisfies ProjectRecord;
  });
  onFacts?.({ rootPath: root, rootLabel: rootLabel(root), scannedAt: fastNow, enriching: true, github: { available: false, login: null }, projects: fastProjects });

  const github = await githubPromise;
  const githubProjects = fastProjects.map((project) => {
    const knownLinked = project.github.repository
      ? github.byFullName.get(project.github.repository.nameWithOwner.toLowerCase()) || project.github.repository
      : null;
    const matchedRepository = github.byName.get(project.name.toLowerCase()) || null;
    return {
      ...project,
      github: {
        state: knownLinked ? "linked" as const : matchedRepository ? "matched" as const : github.available ? "none" as const : "unavailable" as const,
        repository: knownLinked || matchedRepository,
      },
      sync: {
        state: knownLinked ? "unavailable" as const : "no_remote" as const,
        ahead: 0,
        behind: 0,
        checkedRemote: false,
        detail: knownLinked
          ? "The GitHub remote is linked; commit and sync details are still being checked."
          : "No GitHub remote is linked.",
      },
      transient: {
        size: "checking" as const,
        ...(project.git.isRepository ? { git: "checking" as const } : {}),
        ...(knownLinked ? { sync: "checking" as const } : {}),
      },
    } satisfies ProjectRecord;
  });
  const githubResponse: ProjectScanResponse = {
    rootPath: root,
    rootLabel: rootLabel(root),
    scannedAt: new Date().toISOString(),
    enriching: true,
    github: { available: github.available, login: github.login },
    projects: githubProjects,
  };
  onFacts?.(githubResponse);

  const projects = await mapWithConcurrency(githubProjects, 12, async (project) => {
    const projectPath = path.join(root, project.name);
    const names = platform() === "win32"
      ? (await settleWithin(
          readdir(projectPath, { withFileTypes: true }).catch(() => []),
          2_000,
          [],
        )).map((entry) => entry.name)
      : (await run("ls", ["-1A", projectPath], root, 2_000)).stdout.split("\n").filter(Boolean);
    const unavailableDescription: ProjectDescription = {
      text: "",
      compact: "",
      source: "none",
      sourceLabel: "No suitable local description found",
      sourceFile: null,
    };
    const projectPreference = preferenceFor(projectPath);
    const description = await settleWithin(
      platform() === "win32"
        ? discoverProjectDescription(projectPath, names, projectPreference.description)
        : discoverProjectDescriptionWithCommands(root, projectPath, names, projectPreference.description),
      2_500,
      unavailableDescription,
    );

    return {
      ...project,
      description,
      summary: description.compact,
      technologies: detectTechnologies(names),
    } satisfies ProjectRecord;
  });

  const factsResponse: ProjectScanResponse = {
    ...githubResponse,
    scannedAt: new Date().toISOString(),
    projects,
  };
  onFacts?.(factsResponse);

  // Size measurement is intentionally last. A large dependency tree can keep
  // du busy for tens of seconds, but it must never compete with names, local
  // Git facts, descriptions, or GitHub linkage needed for the useful ledger.
  const projectSizes = await measureProjectSizesForRoot(root, folderNames);
  return {
    ...factsResponse,
    scannedAt: new Date().toISOString(),
    projects: projects.map((project) => ({
      ...project,
      size: projectSizes.get(project.name) || { ...SIZE_ERROR },
      transient: project.git.isRepository
        ? { git: "checking" as const, ...(project.github.state === "linked" ? { sync: "checking" as const } : {}) }
        : undefined,
    })),
  };
}

async function resolveProject(name: string) {
  if (!name || name !== path.basename(name) || name === "." || name === "..") {
    throw new ProjectActionError("That project name is not valid.", 400);
  }

  const root = getProjectsRoot();
  const projectPath = path.join(root, name);
  let projectStat;
  try {
    projectStat = await lstat(projectPath);
  } catch {
    throw new ProjectActionError("That project folder no longer exists.", 404);
  }

  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
    throw new ProjectActionError("Actions are only available for direct project folders.", 400);
  }

  return { root, projectPath, canonicalPath: await canonicalizeProjectPath(projectPath) };
}

export async function setProjectPreferences(
  name: string,
  patch: { ignored?: boolean; localOnly?: boolean; description?: string | null },
) {
  const { canonicalPath } = await resolveProject(name);
  const current = settings.projects[canonicalPath] || {};
  const next: StoredProjectPreference = { ...current };
  if (typeof patch.ignored === "boolean") next.ignored = patch.ignored;
  if (typeof patch.localOnly === "boolean") next.localOnly = patch.localOnly;
  if (patch.description === null) delete next.description;
  else if (typeof patch.description === "string") {
    const cleaned = cleanDescription(patch.description).slice(0, 2_000).trim();
    if (!cleaned) delete next.description;
    else next.description = cleaned;
  }
  if (!next.ignored && !next.localOnly && !next.description) delete settings.projects[canonicalPath];
  else settings.projects[canonicalPath] = next;
  await persistSettings();
  return {
    message: patch.ignored === true
      ? `${name} moved to Ignored.`
      : patch.ignored === false
        ? `${name} restored to the working set.`
        : patch.localOnly === true
          ? `${name} will stay local only.`
          : patch.localOnly === false
            ? `GitHub publishing is allowed for ${name}.`
            : patch.description === null
              ? `Local description cleared for ${name}.`
              : `Local description saved for ${name}.`,
    project: await refreshedProject(name),
  };
}

async function ensureGitRepository(projectPath: string) {
  if (await exists(path.join(projectPath, ".git"))) return false;
  const initialized = await run("git", ["init", "-b", "main"], projectPath, 10_000);
  if (!initialized.ok) {
    throw new ProjectActionError(
      friendlyCommandError(initialized, "Git could not initialize this folder."),
    );
  }
  return true;
}

async function refreshedProject(name: string) {
  const root = getProjectsRoot();
  const github = await getGithubContext(root);
  return scanProject(root, name, github, true);
}

export async function initializeProject(name: string) {
  const { projectPath } = await resolveProject(name);
  const initialized = await ensureGitRepository(projectPath);
  return {
    message: initialized ? "Git initialized on the main branch." : "This folder is already a Git repository.",
    project: await refreshedProject(name),
  };
}

export async function linkMatchedRepository(name: string) {
  const { root, projectPath, canonicalPath } = await resolveProject(name);
  assertGithubActionAllowed(name, canonicalPath, "linking a repository");
  const github = await getGithubContext(root);
  if (!github.available) {
    throw new ProjectActionError("Sign in with GitHub CLI before linking repositories.", 409);
  }
  const repository = github.byName.get(name.toLowerCase());
  if (!repository) {
    throw new ProjectActionError("No exact-name GitHub repository was found for this folder.", 404);
  }

  const initialized = await ensureGitRepository(projectPath);
  const existingOrigin = await run("git", ["remote", "get-url", "origin"], projectPath);
  if (existingOrigin.ok) {
    throw new ProjectActionError("This repository already has an origin remote.", 409);
  }

  const linked = await run(
    "git",
    ["remote", "add", "origin", `${repository.url}.git`],
    projectPath,
    10_000,
  );
  if (!linked.ok) {
    throw new ProjectActionError(
      initialized
        ? `Git initialized locally, but ${repository.nameWithOwner} could not be added as origin. The local .git folder remains; no files or commits were changed.`
        : friendlyCommandError(linked, "The GitHub repository could not be linked."),
      409,
      { code: initialized ? "initialized_link_failed" : "link_failed", project: await refreshedProject(name) },
    );
  }

  return {
    message: initialized
      ? `Git initialized locally and ${repository.nameWithOwner} linked as origin.`
      : `Linked ${repository.nameWithOwner} as origin.`,
    project: await refreshedProject(name),
  };
}

function githubSafeName(name: string) {
  return name
    .trim()
    .replace(/\s+/gu, "-")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 100);
}

export async function createGithubRepository(
  name: string,
  visibility: "private" | "public",
) {
  const { root, projectPath, canonicalPath } = await resolveProject(name);
  assertGithubActionAllowed(name, canonicalPath, "creating a GitHub repository");
  const github = await getGithubContext(root);
  if (!github.available) {
    throw new ProjectActionError("Sign in with GitHub CLI before creating a repository.", 409);
  }

  const initialized = await ensureGitRepository(projectPath);
  const existingOrigin = await run("git", ["remote", "get-url", "origin"], projectPath);
  if (existingOrigin.ok) {
    throw new ProjectActionError("This project already has an origin remote.", 409);
  }

  const repositoryName = githubSafeName(name);
  if (!repositoryName) {
    throw new ProjectActionError("This folder name cannot be used as a GitHub repository name.");
  }

  const created = await run(
    "gh",
    [
      "repo",
      "create",
      repositoryName,
      visibility === "public" ? "--public" : "--private",
      "--source",
      projectPath,
      "--remote",
      "origin",
    ],
    root,
    30_000,
  );
  if (!created.ok) {
    const originAfterFailure = await run("git", ["remote", "get-url", "origin"], projectPath);
    const project = await refreshedProject(name);
    if (originAfterFailure.ok) {
      throw new ProjectActionError(
        `GitHub repository setup did not finish, but origin now exists for ${name}. Local Git and the remote remain unchanged from that partial result; no commit or push was run.`,
        409,
        { code: "create_remote_partial", project },
      );
    }
    if (initialized) {
      throw new ProjectActionError(
        `Git initialized locally for ${name}, but GitHub repository creation failed. The local .git folder remains; no commit or push was run.`,
        409,
        { code: "create_after_init_failed", project },
      );
    }
    throw new ProjectActionError(
      friendlyCommandError(created, "GitHub could not create the repository."),
      409,
      { code: "create_failed", project },
    );
  }

  return {
    message: `${initialized ? "Initialized local Git, created" : "Created"} ${github.login}/${repositoryName} as a ${visibility} repository, and added origin. No commit or push was run.`,
    project: await refreshedProject(name),
  };
}

function looksSensitive(fileName: string) {
  const lower = fileName.toLowerCase();
  const base = path.basename(lower);
  return (
    /^\.env(?:\.|$)/u.test(base) ||
    /(?:^|\/)(?:id_rsa|id_ed25519)$/u.test(lower) ||
    /\.(?:pem|key|p12|pfx)$/u.test(lower) ||
    /(?:credentials|service-account).*\.json$/u.test(base)
  );
}

type CommitPushOptions = {
  execute?: typeof run;
  refresh?: (name: string) => Promise<ProjectRecord>;
};

export async function commitAndPushProject(name: string, requestedMessage: string, options: CommitPushOptions = {}) {
  const { projectPath, canonicalPath } = await resolveProject(name);
  assertGithubActionAllowed(name, canonicalPath, "publishing to GitHub");
  const execute = options.execute || run;
  const refresh = options.refresh || refreshedProject;
  if (!(await exists(path.join(projectPath, ".git")))) {
    throw new ProjectActionError("Initialize Git before pushing this project.", 409);
  }

  const origin = await execute("git", ["remote", "get-url", "origin"], projectPath);
  if (!origin.ok || !parseGithubRemote(origin.stdout)) {
    throw new ProjectActionError("Link a GitHub repository before pushing.", 409);
  }

  const branchResult = await execute("git", ["branch", "--show-current"], projectPath);
  const branch = branchResult.stdout;
  if (!branch) {
    throw new ProjectActionError("Choose a branch before pushing this repository.", 409);
  }

  const untracked = await execute(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    projectPath,
    8_000,
  );
  const sensitiveFiles = untracked.stdout.split("\n").filter(looksSensitive);
  if (sensitiveFiles.length) {
    throw new ProjectActionError(
      `Push stopped: add ${sensitiveFiles.slice(0, 3).join(", ")} to .gitignore or review it manually first.`,
      409,
    );
  }

  await execute("git", ["fetch", "--quiet", "--prune", "origin"], projectPath, 12_000);
  const remoteBranch = await execute(
    "git",
    ["show-ref", "--verify", `refs/remotes/origin/${branch}`],
    projectPath,
  );
  if (remoteBranch.ok) {
    const comparison = await execute(
      "git",
      ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`],
      projectPath,
    );
    if (comparison.ok) {
      const [behind = 0] = comparison.stdout
        .split(/\s+/u)
        .map((value) => Number.parseInt(value, 10) || 0);
      if (behind > 0) {
        throw new ProjectActionError(
          "GitHub has commits that are not local. Pull and resolve them before pushing.",
          409,
        );
      }
    }
  }

  const status = await execute("git", ["status", "--porcelain"], projectPath, 15_000);
  if (!status.ok) {
    throw new ProjectActionError(
      friendlyCommandError(status, "The working tree could not be checked before pushing."),
      409,
    );
  }
  const hasHeadBefore = await execute("git", ["rev-parse", "HEAD"], projectPath);
  const requiresMessage = Boolean(status.stdout) || !hasHeadBefore.ok;
  const message = requestedMessage.trim().slice(0, 120);
  if (requiresMessage && !message) {
    throw new ProjectActionError("Enter a commit message before creating the commit. No files were staged and no push was attempted.", 400, { code: "commit_message_required" });
  }
  let committed = false;
  let emptyInitialCommit = false;
  if (status.stdout) {
    const staged = await execute("git", ["add", "-A"], projectPath, 30_000);
    if (!staged.ok) {
      throw new ProjectActionError(
        friendlyCommandError(staged, "Local changes could not be staged."),
      );
    }

    const committedResult = await execute(
      "git",
      ["commit", "-m", message],
      projectPath,
      30_000,
    );
    if (!committedResult.ok) {
      throw new ProjectActionError(
        friendlyCommandError(committedResult, "Local changes could not be committed."),
        409,
      );
    }
    committed = true;
  }

  const hasHead = committed ? { ok: true } : hasHeadBefore;
  if (!hasHead.ok) {
    const emptyCommit = await execute(
      "git",
      ["commit", "--allow-empty", "-m", message],
      projectPath,
      30_000,
    );
    if (!emptyCommit.ok) {
      throw new ProjectActionError(
        friendlyCommandError(emptyCommit, "The initial commit could not be created."),
        409,
      );
    }
    committed = true;
    emptyInitialCommit = true;
  }

  const pushed = await execute("git", ["push", "-u", "origin", branch], projectPath, 30_000);
  if (!pushed.ok) {
    if (!hasHeadBefore.ok && committed) {
      throw new ProjectActionError(
        `Initial commit created locally, but push failed. ${friendlyCommandError(pushed, "Retry Push to GitHub when the remote is available.")}`,
        409,
        { code: emptyInitialCommit ? "empty_initial_push_failed" : "initial_push_failed", project: await refresh(name) },
      );
    }
    if (committed) {
      throw new ProjectActionError(
        `Commit created locally, but push failed. ${friendlyCommandError(pushed, "Retry Push to GitHub when the remote is available.")}`,
        409,
        { code: "commit_push_failed", project: await refresh(name) },
      );
    }
    throw new ProjectActionError(
      friendlyCommandError(pushed, "The project could not be pushed to GitHub."),
      409,
      { code: "push_failed", project: await refresh(name) },
    );
  }

  return {
    message: !hasHeadBefore.ok
      ? emptyInitialCommit
        ? "Empty initial commit created and pushed to GitHub."
        : "Initial commit created and pushed to GitHub."
      : committed
        ? "Committed local changes and pushed them to GitHub."
        : "Pushed local commits to GitHub.",
    project: await refresh(name),
  };
}
