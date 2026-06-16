import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Epic 2c-2 (UI half) — the loopback POST /internal/update self-update control hook. HERMETIC +
// CLAUDE-FREE + NETWORK-FREE (Db + buildServer via app.inject; beginSelfUpdate is a SPY, so nothing
// actually spawns/installs). Proves the SAME trust contract as /internal/shutdown PLUS the packaged gate:
//   (a) loopback + PACKAGED → 202 { ok, updating } and INVOKES beginSelfUpdate once (deferred after ack);
//   (b) NON-loopback caller → 403 and beginSelfUpdate is NOT invoked (loopback-only, never reachable by an agent);
//   (c) loopback + SOURCE (from-source daemon) → 409 with a clear message and beginSelfUpdate NOT invoked
//       (packaged-vs-source gating — the npm reinstall is invalid over a checkout);
//   (d) NO MCP EXPOSURE: no MCP router registers a Loom-self-update tool (the only trigger is this loopback
//       REST route — same boundary as the vault/git writers + /internal/shutdown).
// The packaged/source gate is flipped with the LOOM_PACKAGED override (the same seam version.ts documents).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIST_DIR = path.join(__dirname, "..", "dist", "mcp");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-update-ep-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45333";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let updateCalls = 0;
const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
const app = await buildServer({
  db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  runMcp: stub, control: stub, usageStatus: stub,
  requestShutdown: () => {}, beginSelfUpdate: () => { updateCalls++; },
});
try {
  // (a) loopback + PACKAGED → 202 + ack, beginSelfUpdate fired one tick after the ack (mirrors shutdown's defer).
  process.env.LOOM_PACKAGED = "1";
  const res = await app.inject({ method: "POST", url: "/internal/update", remoteAddress: "127.0.0.1" });
  check("(a) POST /internal/update (loopback, packaged) → 202", res.statusCode === 202);
  const body = res.json();
  check("(a) body acks { ok:true, updating:true }", body.ok === true && body.updating === true);
  check("(a) ack returns BEFORE the spawn fires (not yet invoked synchronously)", updateCalls === 0);
  await sleep(120); // > the endpoint's 50ms defer
  check("(a) beginSelfUpdate invoked exactly once after the ack flushed", updateCalls === 1);

  // (b) NON-loopback caller → 403, NOT invoked (same posture as /internal/shutdown + /internal/hook).
  const forbidden = await app.inject({ method: "POST", url: "/internal/update", remoteAddress: "203.0.113.7" });
  check("(b) POST from a non-loopback IP → 403", forbidden.statusCode === 403);
  await sleep(80);
  check("(b) beginSelfUpdate NOT invoked by the rejected caller (still 1)", updateCalls === 1);

  // (c) loopback + SOURCE daemon → 409 with a clear message, NOT invoked (packaged-vs-source gate).
  process.env.LOOM_PACKAGED = "0";
  const refused = await app.inject({ method: "POST", url: "/internal/update", remoteAddress: "127.0.0.1" });
  check("(c) POST on a from-source daemon → 409", refused.statusCode === 409);
  check("(c) 409 body carries a clear refusal message", typeof refused.json().error === "string" && /from-source|packaged/i.test(refused.json().error));
  await sleep(80);
  check("(c) beginSelfUpdate NOT invoked on a source daemon (still 1)", updateCalls === 1);
} finally {
  delete process.env.LOOM_PACKAGED;
  try { await app.close(); } catch { /* ignore */ }
  db.close();
}

// (d) NO MCP EXPOSURE — scan every built MCP router for a Loom-self-update tool. The capability lives ONLY
// on the loopback REST route; an agent can NEVER trigger it. (Data-editing *_update tools like tasks_update
// are unrelated and allowed; the denylist is specifically the daemon/self/version update verbs.)
{
  const SELF_UPDATE_NAMES = new Set([
    "loom_update", "self_update", "daemon_update", "update_loom", "update_daemon",
    "app_update", "trigger_update", "version_update", "loom_self_update", "update",
  ]);
  const names = [];
  for (const f of fs.readdirSync(MCP_DIST_DIR).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(MCP_DIST_DIR, f), "utf8");
    const re = /registerTool\(\s*["'`]([^"'`]+)["'`]/g;
    let m;
    while ((m = re.exec(src)) !== null) names.push(m[1]);
  }
  check("(d) the MCP-tool scan actually found tools (sanity)", names.length > 0);
  const offenders = names.filter((n) => SELF_UPDATE_NAMES.has(n));
  check(`(d) NO MCP tool can trigger a Loom self-update (offenders: ${offenders.join(", ") || "none"})`, offenders.length === 0);
  // sanity: the unrelated data-editing update tools DO exist (proves the scan reads names correctly)
  check("(d) scan sees the benign data tools (e.g. tasks_update)", names.includes("tasks_update"));
}

for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — POST /internal/update is loopback-only (403 otherwise), packaged-only (409 on a source daemon), acks 202 + triggers the self-update exactly once, and is NOT exposed as any agent MCP tool. Same trust boundary as /internal/shutdown."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
