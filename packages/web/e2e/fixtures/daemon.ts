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
//   3. Boot `packages/daemon/dist/index.js` with a scratch LOOM_HOME, `LOOM_PORT=0` (an OS-assigned
//      free port — collision-proof even across concurrent `playwright test` invocations, not just
//      concurrent workers within one run), LOOM_WEB_DIST pointed at the built web app, LOOM_DEV=0,
//      LOOM_SCHEDULER_ENABLED=0, LOOM_PYTHON_NO_PROVISION=1. The daemon's own listen line is parsed
//      for the real bound URL — never assume the port bound.
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

// The no-spawn guard: patterns that, if seen in the daemon's boot/session log, mean a REAL (metered)
// claude may have spawned — the wipe-prod class of accident this hermetic fixture exists to prevent.
// NOTE the WORD BOUNDARY on the first pattern (`spawn\b`, not a bare `spawn`): a real claude spawn logs
// `[pty] spawn <sessionId> …` (pty/host.ts) — "spawn" followed by a space. A benign LOCAL host shell
// (`POST /api/terminals`) logs `[pty] spawnShell <id> …` — "spawn" followed by "Shell", NO boundary — and
// is UNMETERED + local, so it must NOT trip the guard (it's exercised as a live ShellTile in
// sessions-terminals.spec.ts). `spawn\b` matches `spawn ` (→ boundary) but never `spawnShell` (n→S, no
// boundary), so a real claude spawn is STILL caught by construction while `spawnShell` is let through.
// This narrowing is regression-proofed by no-spawn-guard.spec.ts — do not widen it back to a bare `spawn`.
export const FORBIDDEN_LOG_PATTERNS: RegExp[] = [
  /\[pty\] spawn\b/,
  /first-run: auto-launched/,
];

export function assertNoRealClaudeSpawn(log: string, when: string): void {
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

export interface SeededCompanion {
  projectId: string;
  agentId: string;
  sessionId: string;
  memoryName: string;
  reminderLabel: string;
}

/** A role for a seeded live session: "plain" is the role-less standalone session (stored as NULL role). */
export type SeededLiveRole = "plain" | "manager" | "worker" | "setup" | "workspace-auditor" | "auditor" | "platform" | "assistant";

/** The rows a {@link LoomDaemon.seedLiveSession} call created + the names/titles a spec asserts on. */
export interface SeededLiveSession {
  project: SeededProject;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  role: SeededLiveRole;
  /** The bound board task (present only when `task` was requested) — its id + title for assertions. */
  taskId?: string;
  taskTitle?: string;
  /** The seeded wake's note (present only when `wake` was requested) — the SessionWakes chip text. */
  wakeNote?: string;
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
  /**
   * Seed one `session_usage_samples` row via the test-only POST /internal/test/seed (card 32fd6f4c) — the
   * ONLY way an e2e spec can put data on the Usage page's "Interactive sessions" plane, since that table
   * is otherwise written ONLY by the internal daemon sampler. `LOOM_TEST=1` (set on this fixture's daemon)
   * is what mounts the endpoint; it's entirely absent on a real daemon. Returns the inserted sample id.
   */
  seedUsageSample: (sample: {
    projectId: string;
    sessionId?: string;
    agentId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
  }) => Promise<string>;
  /**
   * Seed a full companion (card 0954ed9c: the Companion Manage e2e spec) via the test-only
   * POST /internal/test/seed — a NOT-LIVE assistant-role session bound to a fresh project+agent, a
   * companion config row (with a bot token, so the Manage tab's masked read-back has something to mask),
   * one authored memory entry, and one reminder. NEVER calls `/api/companion/provision` (spawns a real
   * assistant session) or `/api/companion/config` (arms the runtime via `reconcile()`) — both would trip
   * this fixture's `[pty] spawn` no-spawn guard. Returns the ids the seeded rows carry, plus the seeded
   * memory/reminder's own names for spec assertions.
   */
  seedCompanion: (opts?: {
    name?: string;
    botToken?: string;
    allowedChatId?: string;
    memoryName?: string;
    memoryContent?: string;
    reminderLabel?: string;
    reminderPrompt?: string;
  }) => Promise<SeededCompanion>;
  /**
   * Seed a LIVE-but-NO-PTY session (card d01311b6: the unified terminal / sessions e2e spec) via the
   * test-only POST /internal/test/seed — a `processState:"live"` session row inserted directly through
   * `deps.db.insertSession`, so it renders as live in the session list + the unified <TerminalCard> chrome
   * mounts, while the /ws/term attach is a genuine no-op (no pty). NEVER calls startSession (which spawns a
   * real claude and would trip this fixture's `[pty] spawn` no-spawn guard). By default it mints its OWN
   * fresh project + agent; pass `project`/`agentId` to place several sessions in ONE project (e.g. a manager
   * + its worker for the fleet grouping / role-scoped tabs). Optionally binds a board task (`task`, so the
   * SessionTaskCard sub-panel renders) and/or a pending wake (`wake`, so the SessionWakes sub-panel renders
   * — both draw nothing when empty). Returns the seeded ids + names/titles for assertions.
   */
  seedLiveSession: (opts?: {
    project?: SeededProject;
    agentId?: string;
    agentName?: string;
    role?: SeededLiveRole;
    busy?: boolean;
    parentSessionId?: string;
    branch?: string;
    title?: string;
    task?: { title?: string; body?: string; columnKey?: string; priority?: "p0" | "p1" | "p2" | "p3" };
    wake?: { note?: string };
  }) => Promise<SeededLiveSession>;
  /**
   * Spawn ONE real, LIVE host shell via `POST /api/terminals` (card ShellTile-e2e) — the ONLY way to make a
   * live ShellTile render, since a raw shell is an ephemeral PtyHost process, not a DB Session row (so it can
   * NOT be seeded through /internal/test/seed like a live session). This logs `[pty] spawnShell …`, which the
   * narrowed no-spawn guard (`/\[pty\] spawn\b/`) DELIBERATELY lets through — a local host shell is unmetered
   * and benign, unlike a real claude `[pty] spawn …`. With no `command`, the daemon uses its detected default
   * shell (pwsh/cmd on win32, `$SHELL`/bash on POSIX), so this stays cross-platform. Tracks the id for
   * {@link LoomDaemon.killSpawnedShells}. Returns the spawned shell's id + the owning project (for filtering
   * the /terminals grid to this test's shell on the shared worker daemon).
   */
  spawnShell: (opts?: { project?: SeededProject; command?: string; label?: string }) => Promise<{
    id: string;
    project: SeededProject;
    projectName: string;
    label: string;
  }>;
  /**
   * Hard-kill (`DELETE /api/terminals/:id`) every shell spawned by {@link LoomDaemon.spawnShell} so far. Call
   * in an afterEach: a leaked live shell would keep a real host pty alive and pollute a sibling spec's Shells
   * lane. Idempotent (an already-gone id is a no-op on the daemon side).
   */
  killSpawnedShells: () => Promise<void>;
  /**
   * Archive every session seeded by {@link LoomDaemon.seedLiveSession} OR {@link LoomDaemon.seedCompanion} so
   * far (sets archived_at via the test-only seed endpoint), removing them from the session rail. Call in an
   * afterEach: the e2e worker daemon is SHARED across spec files, so a lingering session row (a `live`
   * terminal OR a non-archived exited companion) would pollute a LATER spec's global "no live sessions"
   * empty-state — the Usage page's Live-occupancy plane counts EVERY non-archived session, not just live
   * ones. Idempotent (an already-archived / unknown id is a no-op).
   */
  archiveSeededSessions: () => Promise<void>;
}

export const test = base.extend<{ loomPage: Page }, { loomDaemon: LoomDaemon }>({
  // eslint-disable-next-line no-empty-pattern
  loomDaemon: [async ({}, use) => {
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

    // LOOM_PORT=0 asks the daemon to bind an OS-assigned free port — never a fixed number, so
    // concurrent `playwright test` invocations on the same machine (not just concurrent workers
    // within one run) can never collide on it. The daemon's listen line reports the real bound
    // port (index.ts logs fastify's resolved `listeningOrigin`, not the raw LOOM_PORT env value).

    let log = "";
    const child = spawn(process.execPath, [DAEMON_INDEX], {
      env: {
        ...process.env,
        LOOM_HOME: loomHome,
        LOOM_PORT: "0",
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

    // Track every seeded session id (live terminals + companions) so afterEach can archive them off the
    // shared daemon's rail (any non-archived row pollutes a later spec's global "no live sessions" state).
    const seededSessionIds: string[] = [];

    const seedUsageSample: LoomDaemon["seedUsageSample"] = async (sample) => {
      const res = await apiPost<{ usageSampleIds: string[] }>(baseURL, "/internal/test/seed", {
        usageSamples: [{ sessionId: `e2e-session-${randomUUID()}`, ...sample }],
      });
      return res.usageSampleIds[0];
    };

    const seedCompanion: LoomDaemon["seedCompanion"] = async (opts = {}) => {
      const project = await createProject(`companion-${randomUUID()}`);
      const name = opts.name ?? "Ada";
      // The agent's own `name` is what the Companion page's header label actually renders (via the
      // seeded session's `agentName`) — the companion CONFIG's own `name` field (below) is stored +
      // returned masked over REST but has no dedicated display in the Manage tab today. Using the same
      // name for both means a spec asserting "the companion's name is visible" holds either way.
      const agent = await apiPost<{ id: string }>(baseURL, `/api/projects/${project.id}/agents`, { name });
      const sessionId = `e2e-companion-${randomUUID()}`;
      const memoryName = opts.memoryName ?? "user-preferences";
      const reminderLabel = opts.reminderLabel ?? "Morning check-in";
      await apiPost(baseURL, "/internal/test/seed", {
        companionSessions: [{ id: sessionId, projectId: project.id, agentId: agent.id }],
        companionConfigs: [{
          sessionId, enabled: true, name,
          botToken: opts.botToken ?? "123456:e2e-test-token",
          allowedChatId: opts.allowedChatId ?? "999",
        }],
        companionMemories: [{
          sessionId, name: memoryName,
          content: opts.memoryContent ?? "---\ndescription: seeded for the Companion Manage e2e spec\n---\nLikes concise answers.",
        }],
        companionReminders: [{ sessionId, label: reminderLabel, prompt: opts.reminderPrompt ?? "Anything worth surfacing?" }],
      });
      // Track for archiveSeededSessions: a seeded companion is a non-archived (exited) session row, so it too
      // counts in a later spec's global "no live sessions" plane if it isn't cleaned up.
      seededSessionIds.push(sessionId);
      return { projectId: project.id, agentId: agent.id, sessionId, memoryName, reminderLabel };
    };

    const seedLiveSession: LoomDaemon["seedLiveSession"] = async (opts = {}) => {
      const project = opts.project ?? await createProject(`live-${randomUUID().slice(0, 8)}`);
      const agentName = opts.agentName ?? "Seeded Agent";
      const agentId = opts.agentId
        ?? (await apiPost<{ id: string }>(baseURL, `/api/projects/${project.id}/agents`, { name: agentName })).id;
      const role = opts.role ?? "plain";

      let taskId: string | undefined;
      let taskTitle: string | undefined;
      if (opts.task) {
        const t = await createTask(project.id, {
          title: opts.task.title ?? `bound-task-${randomUUID().slice(0, 8)}`,
          body: opts.task.body,
          columnKey: opts.task.columnKey ?? "in_progress",
          priority: opts.task.priority,
        });
        taskId = t.id;
        taskTitle = t.title;
      }

      const sessionId = `e2e-live-${randomUUID()}`;
      const wakeNote = opts.wake ? (opts.wake.note ?? "seeded wake — e2e") : undefined;
      await apiPost(baseURL, "/internal/test/seed", {
        liveSessions: [{
          id: sessionId, projectId: project.id, agentId, role, busy: opts.busy ?? false,
          parentSessionId: opts.parentSessionId, taskId, branch: opts.branch, title: opts.title,
        }],
        wakes: opts.wake ? [{ sessionId, note: wakeNote }] : [],
      });
      seededSessionIds.push(sessionId);
      return {
        project, projectId: project.id, projectName: project.name,
        agentId, agentName, sessionId, role, taskId, taskTitle, wakeNote,
      };
    };

    const archiveSeededSessions: LoomDaemon["archiveSeededSessions"] = async () => {
      if (seededSessionIds.length === 0) return;
      const ids = seededSessionIds.splice(0); // clear as we archive — already-archived ids are no-ops
      await apiPost(baseURL, "/internal/test/seed", { archiveSessions: ids });
    };

    // Track every real shell spawned via POST /api/terminals so killSpawnedShells can tear them down.
    const spawnedShellIds: string[] = [];

    const spawnShell: LoomDaemon["spawnShell"] = async (opts = {}) => {
      const project = opts.project ?? await createProject(`shell-${randomUUID().slice(0, 8)}`);
      const term = await apiPost<{ id: string; label: string }>(baseURL, "/api/terminals", {
        projectId: project.id,
        command: opts.command, // undefined ⇒ the daemon's detected default shell (cross-platform)
        label: opts.label,
      });
      spawnedShellIds.push(term.id);
      return { id: term.id, project, projectName: project.name, label: term.label };
    };

    const killSpawnedShells: LoomDaemon["killSpawnedShells"] = async () => {
      if (spawnedShellIds.length === 0) return;
      const ids = spawnedShellIds.splice(0); // clear as we kill — DELETE is idempotent for an already-gone id
      for (const id of ids) {
        try { await fetch(`${baseURL}/api/terminals/${id}`, { method: "DELETE" }); } catch { /* best-effort */ }
      }
    };

    await use({ baseURL, createProject, createTask, seedUsageSample, seedCompanion, seedLiveSession, spawnShell, killSpawnedShells, archiveSeededSessions });

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
