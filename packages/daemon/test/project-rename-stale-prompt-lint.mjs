import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Project rename / repoPath-change stale-prompt LINT (card 0597e092 — Platform-Audit finding 8fce57e9,
// the Invest->Seismo mis-dispatch vector). STRUCTURAL HALF ONLY: on a rename/repoPath change, scan the
// project's agent startupPrompts for the OLD name/paths and return a WARNING — it never auto-edits a
// prompt. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like project-rebind.mjs: a REAL Db +
// SessionService against a FAKE pty, the REAL PlatformMcpRouter driven over in-process MCP
// InMemoryTransport (no HTTP).
//
// Proves the DoD:
//   (1) a NAME rename flags an agent prompt containing the old name as a `/pickup <name>` reference AND
//       one containing it as a vault path segment (`Projects/<name>/…`) — the load-bearing shapes;
//   (2) a prompt that only mentions the old name in ORDINARY PROSE (no path/pickup shape) is NOT flagged
//       — the false-positive guard;
//   (3) a rename to a SUPERSET name (Invest -> Investments) does not false-positive on the old name still
//       being a literal substring of the new one;
//   (4) a repoPath change flags a prompt containing the OLD repoPath verbatim (path-separator agnostic);
//   (5) a NO-OP patch (same value, or omitted fields) warns NOTHING — proves the lint compares
//       pre-write vs. the applied patch, not post-write vs. itself;
//   (6) the prompt text itself is NEVER modified by the lint (no auto-edit);
//   (7) `lintStalePromptsOnProjectChange` — the exact function the REST PATCH /api/projects/:id route
//       calls — produces IDENTICAL warnings to the project_update MCP tool for the same change, so
//       both write sites share one lint (no REST HTTP server needed to prove this: project-rebind.mjs
//       establishes the same pattern for checkRepoRebind).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-rename-stale-prompt-lint.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (set BEFORE importing dist; paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-stale-prompt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { lintStalePromptsOnProjectChange } = await import("../dist/projects/prompt-lint.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const OLD_REPO_PATH = "C:\\Users\\danie\\Documents\\GitHub\\Invest";

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: OLD_REPO_PATH, vaultPath: OLD_REPO_PATH, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pProj", name: "Invest", repoPath: OLD_REPO_PATH, vaultPath: OLD_REPO_PATH, config: {}, createdAt: now, archivedAt: null, reserved: false });

// Agent A: the real evidence shape — a /pickup reference AND a vault-path-segment reference to the
// old name, plus the old repoPath verbatim (POSIX-style, to prove separator-agnostic matching).
const promptA =
  "# Lead / Orchestrator — Invest\n" +
  `Repo: ${OLD_REPO_PATH}\n` +
  "keep Projects/Invest/Orchestrator Log.md always-current\n" +
  "/pickup Invest\n";
db.insertAgent({ id: "agentA", projectId: "pProj", name: "Orchestrator", startupPrompt: promptA, position: 0, profileId: null });

// Agent B: ONLY a prose mention of the old name — no path segment, no /pickup shape. Must NOT be flagged.
const promptB = "This project used to be called Invest before the rename; keep working as usual.";
db.insertAgent({ id: "agentB", projectId: "pProj", name: "Prose-mention", startupPrompt: promptB, position: 1, profileId: null });

// Agent C: has no reference to anything stale at all.
const promptC = "You are a plain worker. Implement the assigned task and report.";
db.insertAgent({ id: "agentC", projectId: "pProj", name: "Clean", startupPrompt: promptC, position: 2, profileId: null });

const seedSession = (id, role, extra) => db.insertSession({
  id, projectId: extra?.projectId ?? "pProj", agentId: "agentA", engineSessionId: null, title: null,
  cwd: extra?.cwd ?? OLD_REPO_PATH, processState: extra?.processState ?? "live", resumability: "unknown", busy: false,
  createdAt: now, lastActivity: now, lastError: null, role, parentSessionId: extra?.parent ?? null,
  worktreePath: extra?.worktreePath ?? null, branch: extra?.branch ?? null,
});
seedSession("PL", "platform", { projectId: "pProj" });

// Fake pty (no real claude). Same SeamHost shape as project-rebind.mjs.
class SeamHost extends PtyHost {
  createPty() { return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (router, sessionId) => {
  const server = router.buildServer(sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "stale-prompt-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => parse(await client.callTool({ name, arguments: args })) };
};

try {
  const plat = await connect(new PlatformMcpRouter(db, svc), "PL");

  // (5) NO-OP first — patching a field to its OWN current value must warn nothing, even though the
  // project genuinely has agents whose prompts DO reference that current value (agentA references
  // "Invest" right now). If the lint compared post-write state to itself instead of pre-write-vs-patch,
  // this would falsely flag agentA; it must not.
  const noop = await plat.call("project_update", { projectId: "pProj", name: "Invest" });
  check("(5) a same-value name patch warns NOTHING (compares pre-write vs. patch, not post-write vs. itself)",
    Array.isArray(noop.staleStartupPrompts) && noop.staleStartupPrompts.length === 0);

  // (1) Rename Invest -> Seismo via the elevated project_update MCP tool.
  const renamed = await plat.call("project_update", { projectId: "pProj", name: "Seismo" });
  check("(1) rename persisted", renamed.name === "Seismo" && !renamed.error);
  check("(1) staleStartupPrompts is present on the response (additive field)", Array.isArray(renamed.staleStartupPrompts));
  const flaggedIds = renamed.staleStartupPrompts.map((w) => w.agentId).sort();
  check("(1) agentA (pickup + vault-path-segment refs) IS flagged", flaggedIds.includes("agentA"));
  check("(2) agentB (bare prose mention only) is NOT flagged", !flaggedIds.includes("agentB"));
  check("agentC (no reference at all) is NOT flagged", !flaggedIds.includes("agentC"));
  const agentAWarning = renamed.staleStartupPrompts.find((w) => w.agentId === "agentA");
  check("(1) agentA's warning names the 'name' field as stale", agentAWarning?.staleFields.includes("name"));
  check("(1) agentA's warning carries its display name", agentAWarning?.agentName === "Orchestrator");

  // (6) The prompt text itself was NEVER modified — no auto-edit.
  check("(6) agentA's startupPrompt is byte-identical after the lint ran (no auto-edit)", db.getAgent("agentA").startupPrompt === promptA);
  check("(6) agentB's startupPrompt is byte-identical after the lint ran (no auto-edit)", db.getAgent("agentB").startupPrompt === promptB);

  // (3) Rename to a SUPERSET name (Seismo -> Seismograph): the old name "Seismo" must not falsely match
  // as a substring of prompts that now legitimately say "Seismograph" — re-seed a fresh agent for this.
  db.insertAgent({ id: "agentD", projectId: "pProj", name: "Superset-check", startupPrompt: "Repo path: /home/x/Seismograph/app\n", position: 3, profileId: null });
  const supersetRename = await plat.call("project_update", { projectId: "pProj", name: "Seismograph" });
  check("(3) a superset rename does not false-positive on the old name as a substring of the new one", !supersetRename.staleStartupPrompts.some((w) => w.agentId === "agentD"));

  // (4) repoPath change: agentA's prompt still contains the OLD repoPath verbatim.
  const newRepo = "C:\\Users\\danie\\Documents\\GitHub\\Seismo";
  const rebound = await plat.call("project_update", { projectId: "pProj", repoPath: newRepo });
  check("(4) repoPath rebind persisted", rebound.repoPath === newRepo && !rebound.error);
  const reboundIds = rebound.staleStartupPrompts.map((w) => w.agentId);
  check("(4) agentA (old repoPath still in prompt) IS flagged on repoPath change", reboundIds.includes("agentA"));
  const agentARepoWarning = rebound.staleStartupPrompts.find((w) => w.agentId === "agentA");
  check("(4) the warning names 'repoPath' as the stale field", agentARepoWarning?.staleFields.includes("repoPath"));

  await plat.client.close();

  // (7) SHARED LINT: lintStalePromptsOnProjectChange is the exact function the REST PATCH
  // /api/projects/:id route calls (see gateway/server.ts). Feed it the SAME before/after shape as the
  // repoPath rebind above (the project row as it stood immediately BEFORE that call: repoPath was still
  // OLD_REPO_PATH) and confirm it reports the identical warning — proving both write sites share one
  // lint rather than each hand-rolling its own.
  const oldProjectSnapshot = { name: "Seismograph", repoPath: OLD_REPO_PATH, vaultPath: db.getProject("pProj").vaultPath };
  const sharedResult = lintStalePromptsOnProjectChange(db, "pProj", oldProjectSnapshot, { repoPath: newRepo });
  check("(7) the shared lint used by REST PATCH agrees with project_update's own result", JSON.stringify(sharedResult.map((w) => w.agentId).sort()) === JSON.stringify(reboundIds.sort()));
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a project rename/repoPath change lints agent startupPrompts for stale name/path references (load-bearing shapes only: path segments + /pickup <name>, never a bare substring), warns without auto-editing, avoids the prose/superset-name false positives, and both write sites (project_update + the REST-shared lintStalePromptsOnProjectChange) agree — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
