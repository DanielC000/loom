// The e2e harness foundation (card c3fd1d68): a worker-scoped fixture that boots ONE isolated, seeded
// Loom daemon per Playwright worker and serves both the API and the built web UI from it (single-process
// mode — see gateway/server.ts `resolveWebDistDir`). Every spec extends `test` from this file instead of
// `@playwright/test` directly, and reaches the running daemon only through `loomDaemon` — never a second
// process, never the owner's live :4317.
//
// Isolated + safe boot recipe (verified — see the [[loom-isolated-daemon-ui-review]] Obsidian vault
// memory + `Projects/Loom/Design/E2E Test Suite Design.md`):
//   1. `pnpm build` must already have run (this fixture only READS dist/ — it never builds).
//   2. Pre-stamp the first-run marker (prestamp.mjs, run as its own child process) so a fresh empty
//      LOOM_HOME never auto-launches the Setup Assistant — a REAL claude — on daemon boot.
//   3. Boot `packages/daemon/dist/index.js` with a scratch LOOM_HOME, a non-default LOOM_PORT,
//      LOOM_WEB_DIST pointed at the built web app, LOOM_DEV=0, LOOM_SCHEDULER_ENABLED=0,
//      LOOM_PYTHON_NO_PROVISION=1. The daemon's own listen line is parsed for the real bound URL —
//      never assume the port bound.
//   4. Assert the boot log carries the listen line and NEVER `[pty] spawn` / `first-run: auto-launched`
//      — fail the fixture loudly if a real claude would have spawned, rather than let a spec run
//      against a compromised boot.
//   5. Teardown via `POST /internal/shutdown` (the same loopback-only hook `loom stop` uses), then a
//      hard-kill backstop, then remove the scratch dirs.
import { test as base, type Page } from "@playwright/test";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/web/e2e/fixtures -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const DAEMON_INDEX = path.join(REPO_ROOT, "packages", "daemon", "dist", "index.js");
const WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
const PRESTAMP_SCRIPT = path.join(__dirname, "prestamp.mjs");

const BOOT_TIMEOUT_MS = 30_000;
// Extra time AFTER the listen line before we trust the "no first-run auto-launch" assertion — the
// daemon logs `[boot] first-run: auto-launched...` (if it were going to) AFTER the listen line, in the
// same synchronous boot continuation, so a short grace window is enough to catch it.
const POST_LISTEN_GRACE_MS = 1500;
const SHUTDOWN_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const FORBIDDEN_LOG_PATTERNS: RegExp[] = [
  /\[pty\] spawn/,
  /first-run: auto-launched/,
];

function assertNoRealClaudeSpawn(log: string, when: string): void {
  for (const pattern of FORBIDDEN_LOG_PATTERNS) {
    if (pattern.test(log)) {
      throw new Error(
        `isolated daemon fixture: boot log matched forbidden pattern ${pattern} (${when}) — ` +
          "a real claude session may have spawned. Refusing to hand this daemon to a spec.",
      );
    }
  }
}

function waitForListenLine(child: ChildProcess, getLog: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not log a listen line within ${BOOT_TIMEOUT_MS}ms. Captured output:\n${getLog()}`));
    }, BOOT_TIMEOUT_MS);
    const onData = () => {
      const m = /listening on (https?:\/\/\S+)/.exec(getLog());
      if (m) { cleanup(); resolve(m[1]); }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`daemon process exited early (code ${code}) before it started listening. Captured output:\n${getLog()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function apiPost<T>(baseURL: string, url: string, body: unknown): Promise<T> {
  const res = await fetch(baseURL + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface SeededProject {
  id: string;
  name: string;
}

export interface SeededTask {
  id: string;
  title: string;
}

export interface LoomDaemon {
  /** The isolated daemon's actual bound origin, e.g. http://127.0.0.1:4399 — parsed from its boot log. */
  baseURL: string;
  /** Seed a project (with a real, empty git repo as repoPath + a plain dir as vaultPath) via REST. */
  createProject: (name?: string) => Promise<SeededProject>;
  /** Seed a board task on a project via REST — the same store the kanban UI and the MCP task tools share. */
  createTask: (
    projectId: string,
    task: { title: string; body?: string; columnKey?: string; priority?: "p0" | "p1" | "p2" | "p3" },
  ) => Promise<SeededTask>;
}

export const test = base.extend<{ loomPage: Page }, { loomDaemon: LoomDaemon }>({
  // eslint-disable-next-line no-empty-pattern
  loomDaemon: [async ({}, use, workerInfo) => {
    if (!existsSync(DAEMON_INDEX)) {
      throw new Error(`daemon dist not found at ${DAEMON_INDEX} — run "pnpm build" first (turbo builds shared -> web -> daemon).`);
    }
    if (!existsSync(path.join(WEB_DIST, "index.html"))) {
      throw new Error(`web dist not found at ${WEB_DIST} — run "pnpm build" first.`);
    }

    const scratchRoot = mkdtempSync(path.join(tmpdir(), "loom-e2e-"));
    const loomHome = path.join(scratchRoot, "home");
    mkdirSync(loomHome, { recursive: true });
    const seedRoot = path.join(scratchRoot, "seed");
    mkdirSync(seedRoot, { recursive: true });

    // 1. Pre-stamp the first-run marker BEFORE the daemon ever boots against this LOOM_HOME.
    execFileSync(process.execPath, [PRESTAMP_SCRIPT], {
      env: { ...process.env, LOOM_HOME: loomHome, LOOM_TEST: "1" },
      stdio: "pipe",
    });

    // Non-default port, offset per worker so a future multi-worker run doesn't collide.
    const port = 4399 + workerInfo.parallelIndex;

    let log = "";
    const child = spawn(process.execPath, [DAEMON_INDEX], {
      env: {
        ...process.env,
        LOOM_HOME: loomHome,
        LOOM_PORT: String(port),
        LOOM_WEB_DIST: WEB_DIST,
        LOOM_DEV: "0",
        LOOM_SCHEDULER_ENABLED: "0",
        LOOM_PYTHON_NO_PROVISION: "1",
        LOOM_TEST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (c: Buffer) => { log += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { log += c.toString(); });

    let baseURL: string;
    try {
      baseURL = await waitForListenLine(child, () => log);
      await sleep(POST_LISTEN_GRACE_MS); // let the post-listen boot continuation (first-run check) finish
      assertNoRealClaudeSpawn(log, "post-boot");
    } catch (err) {
      try { child.kill(); } catch { /* best-effort */ }
      throw err;
    }

    const createProject = async (name?: string): Promise<SeededProject> => {
      const dirId = randomUUID();
      const repoPath = path.join(seedRoot, `repo-${dirId}`);
      const vaultPath = path.join(seedRoot, `vault-${dirId}`);
      mkdirSync(repoPath, { recursive: true });
      mkdirSync(vaultPath, { recursive: true });
      execFileSync("git", ["init", "-q", repoPath]);
      return apiPost<SeededProject>(baseURL, "/api/projects", {
        name: name ?? `e2e-${dirId.slice(0, 8)}`,
        repoPath,
        vaultPath,
      });
    };

    const createTask: LoomDaemon["createTask"] = (projectId, task) =>
      apiPost<SeededTask>(baseURL, `/api/projects/${projectId}/tasks`, task);

    await use({ baseURL, createProject, createTask });

    // Teardown: assert nothing spawned a real claude across the WHOLE session (defense in depth beyond
    // the post-boot check), then shut down gracefully, hard-kill as a backstop, and clean up disk.
    assertNoRealClaudeSpawn(log, "teardown — full session log");
    try { await fetch(`${baseURL}/internal/shutdown`, { method: "POST" }); } catch { /* daemon may already be down */ }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(SHUTDOWN_TIMEOUT_MS),
    ]);
    if (child.exitCode === null && !child.killed) { try { child.kill(); } catch { /* best-effort */ } }
    for (let i = 0; i < 5; i++) {
      try { rmSync(scratchRoot, { recursive: true, force: true }); break; }
      catch { await sleep(300); } // Windows may briefly hold a WAL/db handle after kill
    }
  }, { scope: "worker" }],

  // Convenience: a page whose relative navigations resolve against the isolated daemon's real origin.
  loomPage: async ({ page, loomDaemon }, use) => {
    await page.goto(loomDaemon.baseURL + "/");
    await use(page);
  },
});

export { expect } from "@playwright/test";
