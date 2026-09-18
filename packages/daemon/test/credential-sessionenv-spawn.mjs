import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 82b22817 — RED-before-GREEN proof that a credential stored via question_ask(type:"credential")
// actually reaches a REAL spawned OS child process's env under its declared credentialEnvVar, without
// the human re-typing it and without widening the agent-writable sessionEnv surface (this test wires the
// REAL PtyHost.resolveCredentialSessionEnv callback + a REAL Db — the same production wiring index.ts
// uses — never a mocked resolver).
//
// SHAPE: drives the REAL (unsubclassed) `PtyHost.createCodexPty()` directly — a REAL node-pty spawn, a
// REAL OS child process substituted for the codex binary via `LOOM_CODEX_BIN` (+ a generated `.cmd`
// wrapper on Windows) — the SAME substitution technique `pty-codex-spawn-env.mjs`/`kickoff-real-spawn.mjs`
// already established. Not a mocked exec (memory `real-spawn-smoke-for-subprocess-features`: mocking the
// exec impl never proves bytes cross a real OS process boundary). `createCodexPty` is chosen over the
// full claude `createPty` (same underlying `buildSpawnEnv` call this card touches) because it bypasses
// claude's trust-dialog/busy/readiness machinery entirely, exactly as pty-codex-spawn-env.mjs already
// established for that same reason.
//
// Covers:
//   (A) an answered credentialEnvVar reaches the REAL spawned child's env, decrypted to the exact stored
//       value — never logged or echoed by this file itself.
//   (B) [negative control] a DIFFERENT project's spawn does NOT see this credential — proves the resolver
//       is genuinely project-scoped, not a global leak dressed up as a presence check.
//   (C) a `opts.sessionEnv` entry with the SAME name still wins over the stored credential (human/Lead
//       override always beats an auto-delivered one).
//
// WINDOWS-ONLY (mirrors pty-codex-spawn-env.mjs): the `.cmd`-wrapper mechanism is Windows-specific. SKIPS
// (exit 0) on non-win32 rather than silently passing 0 checks.
//
// Run: 1) build (turbo builds shared first), 2) node test/credential-sessionenv-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  // Card 85bd4052 (sibling of 5978735a): MUST be a `WARN  ` line (exact two-space prefix, test-daemon.mjs's
  // own WARN_LINE_RE) — a bare `SKIP` line is discarded entirely once this file reports a pass, leaving
  // zero trace on ubuntu-latest CI that this file's real coverage never ran there.
  console.log("WARN  SKIP  credential-sessionenv-spawn.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see this file's header for the accepted POSIX gap (mirrors pty-codex-spawn-env.mjs).");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-credential-sessionenv-spawn-");
process.env.LOOM_HOME = tmpHome;

const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { resolveCredentialSessionEnv } = await import("../dist/keys/credentialSessionEnv.js");
const { PtyHost } = await import("../dist/pty/host.js");

const dbFile = path.join(tmpHome, "spawn-cse.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

function mkProject(id) {
  db.insertProject({ id, name: id, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
  const agentId = `${id}-agent`, mgrId = `${id}-mgr`;
  db.insertAgent({ id: agentId, projectId: id, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: id, agentId, engineSessionId: `eng-${id}`, title: null, cwd: id,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  return { projectId: id, agentId, mgrId };
}

const projA = mkProject("cse-spawn-a"); // holds the stored credential
const projB = mkProject("cse-spawn-b"); // holds NONE — the negative-control project

const CREDENTIAL_VALUE = "sk-real-spawn-secret-12345";
{
  const built = buildQuestionAsk(
    // Deliberately NOT a LOOM_-prefixed name — code-review fix 1 (card 82b22817) now REJECTS a
    // LOOM_-prefixed credentialEnvVar at ask time (it collides with Loom's own host-launch vars), so this
    // fixture uses an ordinary-looking name a real project would actually declare.
    { type: "credential", title: "t", body: "b", envVar: "MY_TEST_REAL_CREDENTIAL" },
    { sessionId: projA.mgrId, projectId: projA.projectId, db, role: "manager" },
  );
  if ("error" in built) throw new Error(`unexpected buildQuestionAsk error: ${built.error}`);
  const q = { ...built.question, id: "cse-spawn-q1" };
  db.insertQuestion(q);
  db.answerCredentialQuestion(q.id, { secretBlob: encryptSecret(CREDENTIAL_VALUE), answeredAt: now });
}

// --- the SAME production wiring index.ts uses: the REAL resolver over the REAL Db, never a mock --------
const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
const host = new PtyHost(events, {
  resolveCredentialSessionEnv: (projectId) => resolveCredentialSessionEnv(db, projectId),
});

async function realSpawnEnv(opts) {
  const outputFile = opts.sessionEnv.FIXTURE_ENV_OUTPUT_FILE;
  const pty = host.createCodexPty(opts);
  try {
    await waitUntil(() => fs.existsSync(outputFile), { label: `fixture's env dump file to appear (${opts.sessionId})` });
    return JSON.parse(fs.readFileSync(outputFile, "utf8"));
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

// ===== (A) the stored credential reaches the real spawned child's env =====
{
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-a-"));
  const envOutputFile = path.join(tmpHome, "spawned-env-a.json");
  const spawnedEnv = await realSpawnEnv({
    sessionId: "cse-spawn-session-a",
    cwd: spawnCwd,
    permission: {},
    geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile },
    role: "worker",
    harness: "codex",
    projectId: projA.projectId,
  });
  // Presence + exact-value check, kept OUT of any check() label so the secret is never printed to this
  // test's own stdout/log — only a boolean ever gets logged.
  const present = typeof spawnedEnv.MY_TEST_REAL_CREDENTIAL === "string" && spawnedEnv.MY_TEST_REAL_CREDENTIAL.length > 0;
  check("(A) the stored credential's declared env var is PRESENT in the real spawned child env", present);
  check("(A) the delivered value matches the exact stored plaintext", spawnedEnv.MY_TEST_REAL_CREDENTIAL === CREDENTIAL_VALUE);
}

// ===== (B) negative control — a DIFFERENT project's spawn never sees it =====
{
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-b-"));
  const envOutputFile = path.join(tmpHome, "spawned-env-b.json");
  const spawnedEnv = await realSpawnEnv({
    sessionId: "cse-spawn-session-b",
    cwd: spawnCwd,
    permission: {},
    geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile },
    role: "worker",
    harness: "codex",
    projectId: projB.projectId,
  });
  check("(B) [negative control] a different project's real spawn does NOT see this project's credential", !("MY_TEST_REAL_CREDENTIAL" in spawnedEnv));
}

// ===== (C) a deliberate sessionEnv override still wins on a name collision =====
{
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-c-"));
  const envOutputFile = path.join(tmpHome, "spawned-env-c.json");
  const spawnedEnv = await realSpawnEnv({
    sessionId: "cse-spawn-session-c",
    cwd: spawnCwd,
    permission: {},
    geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile, MY_TEST_REAL_CREDENTIAL: "deliberate-human-override" },
    role: "worker",
    harness: "codex",
    projectId: projA.projectId,
  });
  check("(C) a deliberate opts.sessionEnv entry wins over the auto-delivered credential on a name collision", spawnedEnv.MY_TEST_REAL_CREDENTIAL === "deliberate-human-override");
}

try { db.close(); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — an answered credential with a declared credentialEnvVar reaches a REAL spawned OS child process's env, decrypted to the exact stored plaintext, using the SAME production PtyHost/Db wiring index.ts uses; it never leaks across projects (negative control); and a deliberate sessionEnv override still wins on a name collision."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
