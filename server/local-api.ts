import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ActionResponse } from "../lib/project-types";
import {
  commitAndPushProject,
  chooseProjectsRoot,
  clearGithubContextCache,
  createGithubRepository,
  initializeProject,
  linkMatchedRepository,
  ProjectActionError,
  loadProjectsRoot,
  getGithubAuthentication,
  getProjectsRoot,
  openProjectsRoot,
  scanProjectsProgressively,
  scanProjectsQuick,
  setProjectsRoot,
  setProjectPreferences,
  startGithubAuthentication,
} from "./project-scanner";

const port = Number.parseInt(process.env.GIT_SCAN_API_PORT || "4317", 10);
const SCAN_CACHE_MS = 10 * 60_000;
type ScanResult = Awaited<ReturnType<typeof scanProjectsProgressively>>;
let scanCache: { createdAt: number; value: ScanResult } | null = null;
let quickScanCache: ScanResult | null = null;
let quickScanInFlight: Promise<ScanResult> | null = null;
let quickSizeScanInFlight: Promise<ScanResult> | null = null;
let scanGeneration = 0;
let lastAuthenticatedGithubLogin: string | null = null;
let githubAuthenticationChecked = false;

function invalidateScanCaches(preserveQuick = false) {
  scanGeneration += 1;
  scanCache = null;
  if (!preserveQuick) quickScanCache = null;
  quickScanInFlight = null;
  quickSizeScanInFlight = null;
}

async function getProjectScan(refreshRemote: boolean) {
  if (!refreshRemote && scanCache && Date.now() - scanCache.createdAt < SCAN_CACHE_MS) {
    return scanCache.value;
  }

  if (refreshRemote) {
    clearGithubContextCache();
    invalidateScanCaches(true);
    const generation = scanGeneration;
    if (quickScanCache) {
      quickScanCache = {
        ...quickScanCache,
        scannedAt: new Date().toISOString(),
        enriching: true,
        projects: quickScanCache.projects.map((project) => ({
          ...project,
          transient: {
            ...project.transient,
            git: "checking",
            github: "checking",
            sync: "checking",
          },
        })),
      };
      void startQuickSizeScan(generation, quickScanCache, true);
      return quickScanCache;
    }
    return startQuickScan(generation);
  }

  const generation = scanGeneration;
  if (quickScanCache) return quickScanCache;
  return startQuickScan(generation);
}

function startQuickSizeScan(generation: number, fallback: ScanResult, refreshRemote = false) {
  if (quickSizeScanInFlight) return quickSizeScanInFlight;
  const sizeScan = scanProjectsProgressively(refreshRemote, fallback, (factsValue) => {
    if (generation === scanGeneration) quickScanCache = factsValue;
  })
    .then((sizedValue) => {
      if (generation === scanGeneration) {
        quickScanCache = sizedValue;
        scanCache = { createdAt: Date.now(), value: sizedValue };
      }
      return sizedValue;
    })
    .catch(() => {
      const settledFallback = {
        ...fallback,
        enriching: false,
        projects: fallback.projects.map((project) => ({ ...project, transient: undefined })),
      };
      if (generation === scanGeneration) quickScanCache = settledFallback;
      return settledFallback;
    });
  quickSizeScanInFlight = sizeScan;
  void sizeScan.finally(() => {
    if (quickSizeScanInFlight === sizeScan) quickSizeScanInFlight = null;
  });
  return sizeScan;
}

function startQuickScan(generation = scanGeneration) {
  if (quickScanInFlight) return quickScanInFlight;

  const initialScan = scanProjectsQuick(false).then((value) => {
    if (generation !== scanGeneration) return value;
    if (generation === scanGeneration) quickScanCache = value;
    if (quickSizeScanInFlight) return value;
    void startQuickSizeScan(generation, value);
    return value;
  });
  quickScanInFlight = initialScan;
  return initialScan;
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20 * 1024) throw new ProjectActionError("Request body is too large.", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new ProjectActionError("Request body must be valid JSON.", 400);
  }
}

function routeParts(url: URL) {
  const match = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/(init|link|create-repo|push|preferences)$/u,
  );
  if (!match) return null;
  try {
    return { name: decodeURIComponent(match[1]), action: match[2] };
  } catch {
    throw new ProjectActionError("The project name could not be decoded.", 400);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, null);
      return;
    }

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      const refreshRemote = url.searchParams.get("refresh") === "remote";
      sendJson(response, 200, await getProjectScan(refreshRemote));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/github/auth") {
      const auth = await getGithubAuthentication();
      const loginChanged = githubAuthenticationChecked
        && auth.connected
        && auth.login !== lastAuthenticatedGithubLogin;
      lastAuthenticatedGithubLogin = auth.connected ? auth.login : null;
      githubAuthenticationChecked = true;
      if (loginChanged) {
        clearGithubContextCache();
        if (quickScanCache) {
          invalidateScanCaches(true);
          void startQuickScan(scanGeneration).catch(() => undefined);
        } else {
          // The first inventory request already renders Git/GitHub as checking.
          // Let it finish instead of discarding it during the parallel auth check.
          scanCache = null;
        }
      }
      sendJson(response, 200, auth);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/github/auth") {
      sendJson(response, 200, await startGithubAuthentication());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/root") {
      const body = await readBody(request);
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw new ProjectActionError("Enter a parent folder path.", 400);
      }
      const previousRoot = getProjectsRoot();
      const nextRoot = await setProjectsRoot(body.path);
      if (nextRoot === previousRoot) {
        sendJson(response, 200, { unchanged: true });
        return;
      }
      invalidateScanCaches();
      sendJson(response, 200, await getProjectScan(false));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/root/choose") {
      const previousRoot = getProjectsRoot();
      const nextRoot = await chooseProjectsRoot();
      if (nextRoot === previousRoot) {
        sendJson(response, 200, { unchanged: true });
        return;
      }
      invalidateScanCaches();
      sendJson(response, 200, await getProjectScan(false));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/root/open") {
      sendJson(response, 200, { ok: true, rootPath: await openProjectsRoot() });
      return;
    }

    const route = routeParts(url);
    if (request.method === "POST" && route) {
      const body = await readBody(request);
      let result: Omit<ActionResponse, "ok">;

      switch (route.action) {
        case "init":
          result = await initializeProject(route.name);
          break;
        case "link":
          result = await linkMatchedRepository(route.name);
          break;
        case "create-repo": {
          const visibility = body.visibility === "public" ? "public" : "private";
          result = await createGithubRepository(route.name, visibility);
          break;
        }
        case "push":
          result = await commitAndPushProject(
            route.name,
            typeof body.message === "string" ? body.message : "",
          );
          break;
        case "preferences":
          result = await setProjectPreferences(route.name, {
            ignored: typeof body.ignored === "boolean" ? body.ignored : undefined,
            localOnly: typeof body.localOnly === "boolean" ? body.localOnly : undefined,
            description: body.description === null || typeof body.description === "string"
              ? body.description
              : undefined,
          });
          break;
        default:
          throw new ProjectActionError("Unknown action.", 404);
      }

      invalidateScanCaches();
      sendJson(response, 200, { ok: true, ...result } satisfies ActionResponse);
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    const actionError = error instanceof ProjectActionError ? error : null;
    const message = actionError?.message || "The local project service hit an unexpected error.";
    if (!actionError) console.error(error);
    if (actionError?.project) invalidateScanCaches();
    sendJson(response, actionError?.status || 500, {
      ok: false,
      error: message,
      ...(actionError?.code ? { code: actionError.code } : {}),
      ...(actionError?.project ? { project: actionError.project } : {}),
    });
  }
});

await loadProjectsRoot();
server.listen(port, "127.0.0.1", () => {
  console.log(`Project Deck local API: http://127.0.0.1:${port}`);
});
