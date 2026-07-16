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
  scanProjects,
  scanProjectsQuick,
  setProjectsRoot,
  startGithubAuthentication,
} from "./project-scanner";

const port = Number.parseInt(process.env.GIT_SCAN_API_PORT || "4317", 10);
const SCAN_CACHE_MS = 10 * 60_000;
type ScanResult = Awaited<ReturnType<typeof scanProjects>>;
let scanCache: { createdAt: number; value: ScanResult } | null = null;
let quickScanCache: ScanResult | null = null;
let quickScanInFlight: Promise<ScanResult> | null = null;
let quickSizeScanInFlight: Promise<ScanResult> | null = null;
const scansInFlight = new Map<string, Promise<ScanResult>>();
let scanGeneration = 0;
let lastAuthenticatedGithubLogin: string | null = null;

function invalidateScanCaches() {
  scanGeneration += 1;
  scanCache = null;
  quickScanCache = null;
  quickScanInFlight = null;
  quickSizeScanInFlight = null;
  scansInFlight.clear();
}

async function getProjectScan(refreshRemote: boolean) {
  if (!refreshRemote && scanCache && Date.now() - scanCache.createdAt < SCAN_CACHE_MS) {
    return scanCache.value;
  }

  const generation = scanGeneration;
  const key = `${generation}:${refreshRemote ? "remote" : "local"}`;
  const existing = scansInFlight.get(key);
  if (refreshRemote && existing) return existing;

  if (!existing) {
    const scan = scanProjects(refreshRemote)
      .then((value) => {
        if (generation === scanGeneration) {
          scanCache = { createdAt: Date.now(), value };
        }
        return value;
      })
      .finally(() => scansInFlight.delete(key));
    scansInFlight.set(key, scan);
  }

  if (refreshRemote) return scansInFlight.get(key)!;
  if (quickScanCache) return quickScanCache;
  quickScanInFlight ??= scanProjectsQuick(false).then((value) => {
    if (generation === scanGeneration) quickScanCache = value;
    quickSizeScanInFlight ??= scanProjectsQuick(true)
      .then((sizedValue) => {
        if (generation === scanGeneration) quickScanCache = sizedValue;
        return sizedValue;
      })
      .finally(() => {
        quickSizeScanInFlight = null;
      });
    return value;
  });
  return quickScanInFlight;
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
    /^\/api\/projects\/([^/]+)\/(init|link|create-repo|push)$/u,
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
      if (auth.connected && auth.login !== lastAuthenticatedGithubLogin) {
        lastAuthenticatedGithubLogin = auth.login;
        clearGithubContextCache();
        invalidateScanCaches();
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
      await setProjectsRoot(body.path);
      invalidateScanCaches();
      sendJson(response, 200, await getProjectScan(false));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/root/choose") {
      await chooseProjectsRoot();
      invalidateScanCaches();
      sendJson(response, 200, await getProjectScan(false));
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
    sendJson(response, actionError?.status || 500, { ok: false, error: message });
  }
});

await loadProjectsRoot();
server.listen(port, "127.0.0.1", () => {
  console.log(`Project Deck local API: http://127.0.0.1:${port}`);
});
