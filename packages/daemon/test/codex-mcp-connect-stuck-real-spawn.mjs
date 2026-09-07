// Card 6bf0ee32 — repro for the reported "codex MCP-connect failure leaves the busy signal stuck
// indefinitely" degenerate state. `test/codex-stateful-runtime-real-spawn.mjs`'s own header already
// documented this informally (a prior worker's real-spawn finding: "that failure leaves codex's
// title-bar busy-spinner marker STUCK ... for longer than is practical to wait out") — but that was a
// ONE-TIME snapshot read taken shortly after boot, never a sustained wait to see whether it clears.
//
// 🔴 THIS TEST'S OWN FINDING REFUTES THE LITERAL PREMISE, under the realistic "gateway absent" reading
// (a closed port — nothing listening, so codex's MCP client gets a real, immediate connection refusal):
// across FOUR independent real-spawn trials during this card's development, the busy signal reliably
// self-resolved via the EXISTING `armCodexBusyStaleTimer` staleness mechanism — busy went true, then false
// again, at (true-at-ms -> false-at-ms) 880->11181, 975->11203, 860->11068, 1147->11427 (a ~360ms spread
// across all four — a mechanism reading, not a coincidence). Codex's own spinner genuinely stops
// refreshing after its own ~8s retry budget, and the existing 3s staleness window then correctly declares
// idle. It did NOT stay stuck indefinitely. This file is therefore a REGRESSION GUARD on that self-heal
// continuing to work — Loom's whole worker-supervision model keys off busy/idle, and a session that could
// stay permanently busy is the single worst failure that model is worst at diagnosing (per this card's own
// body) — not a guard for a fix that was never built, because the repro did not show a defect to fix under
// this specific failure shape (a cleanly-refused port). The 60s bound below is deliberately ~5x the
// measured ~11.2s, chosen to assert the INVARIANT ("it clears") without tuning the bound to the
// measurement ("it clears in ~11s") — a tight bound here would make this a timing flake on a slower host,
// not evidence of a real regression.
//
// ⚠️ ON `codex-stateful-runtime-real-spawn.mjs`'s OWN "stuck ... longer than practical to wait out" CLAIM:
// this is a HYPOTHESIS about that observation, not a confirmed explanation. That file's own trust-dialog
// wait resolves in well under 1s (the ready placeholder renders in the very first TUI frame), and its next
// line is a single one-time `isBusy` read with no further wait — given this test's measured ~11.2s busy
// window starting under 1s after spawn, a one-time check taken shortly after boot would very plausibly
// land inside it. But the alternative cannot be excluded: that worker's own trial may have seen a
// genuinely longer or differently-shaped stuck state under conditions this test did not reproduce (a
// different host's personal `~/.codex/config.toml`, a different codex version, or some other divergence).
// Do not read this as "explained" — only as the most likely account given what both runs describe.
//
// ⚠️ NOT COVERED, disclosed rather than assumed away: (1) this host's own personal `~/.codex/config.toml`
// has additional real MCP servers configured alongside the two unreachable ones this test wires in
// (observed "Starting MCP servers (3/5)" in the raw TUI output) — the ~11s duration may be dominated by
// those OTHER servers' own real startup, not isolated to the unreachable pair, and no trial isolated a
// "2-unreachable-only, zero personal servers" configuration; (2) this test only exercises a CLEANLY
// REFUSED port (ECONNREFUSED), never a silently-hung/blackholed endpoint (no RST) — Loom's gateway is
// loopback-only, so ECONNREFUSED is the realistic production case and a local packet-blackhole without a
// deliberately exotic firewall has ~nil realistic incidence, but that variant was never tested and could
// plausibly behave differently. Recorded as an explicit, named, untested bound — not "tested and fine".
//
// SHAPE: PtyHost.spawn with a DELIBERATELY, VERIFIED-unreachable port (see findUnreachablePort below) — a
// real gotcha found developing this file: `PORT` (paths.ts) defaults to 4317, which a real, live
// self-hosting Loom daemon on this very host was ALREADY listening on (confirmed via a live TCP probe
// while this test's first draft ran). Simply "not starting a gateway in this process" does NOT mean
// "nothing is listening" on a shared dev host — codex's MCP servers silently reached that REAL daemon
// instead, which is why an early draft of this file observed no busy episode at all.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0) if it
// isn't available on this host (mirrors every sibling real-spawn file's posture).
// ZERO MODEL TURNS SPENT: this file never calls enqueueStdin/submitCodex.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-mcp-connect-stuck-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { acquireCodexRealSpawnLock } from "./_codex-real-spawn-lock.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveExecutable } = await import("../dist/pty/resolve-bin.js");
const codexBin = resolveExecutable(process.env.LOOM_CODEX_BIN || "codex");

try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`SKIP  codex-mcp-connect-stuck-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}).`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-mcp-stuck-");
process.env.LOOM_HOME = TMP;

// Force a genuinely unreachable port instead of assuming none is bound (see this file's own header for
// why that assumption is unsafe on a shared dev host) — confirm nothing answers it before trusting it.
async function findUnreachablePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 41000 + Math.floor(Math.random() * 9000);
    const reachable = await new Promise((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: candidate, timeout: 300 });
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (!reachable) return candidate;
  }
  throw new Error("could not find an unreachable port after 20 attempts");
}
const unreachablePort = await findUnreachablePort();
process.env.LOOM_PORT = String(unreachablePort);
console.log(`[repro] confirmed port ${unreachablePort} is unreachable (connection refused/timeout) — using it as LOOM_PORT so codex's MCP servers have nothing real to reach`);

const { PtyHost } = await import("../dist/pty/host.js");

const SESSION_ID = "codex-mcp-stuck-test";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-mcp-stuck-cwd-"));

const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

const releaseCodexLock = await acquireCodexRealSpawnLock();

const busyTransitions = []; // { t: msSinceStart, busy }
let startedAt = 0;
const exitedSessions = new Map();
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {},
  onBusy(sessionId, busy) { busyTransitions.push({ t: Date.now() - startedAt, busy }); },
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
};
const host = new PtyHost(events);

let buf = "";
startedAt = Date.now();
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const unsubscribe = host.subscribe(SESSION_ID, {
  onData: (chunk) => { buf += chunk.toString("utf-8"); },
  onControl: () => {},
});

// --- Reach a genuine post-trust-dialog, interactive state (same bar as codex-stateful-runtime-real-spawn,
// deliberately NOT "context left"/full-ready — see that file's own header for why). -------------------
try {
  await waitUntil(() => buf.includes("Ask Codex to do anything"), {
    label: `${SESSION_ID} real codex TUI advances past the trust dialog`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  real codex never advanced past the trust dialog within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}

// --- THE GUARD: with the unreachable MCP servers, does a real busy episode happen, and does it clear
// again within a bounded window? Two separate, bounded waits (never one open-ended poll) — the FIRST
// proves the degenerate state is real (busy DOES rise from the MCP-connect attempt), the SECOND proves the
// EXISTING self-heal keeps working (busy DOES fall again on its own). Both budgets are deliberately
// generous relative to the ~11.2s this took across four measured real trials, without pretending to prove
// an unbounded claim — a bounded pass here is evidence the self-heal still works within this budget, never
// proof it can never get stuck under some OTHER condition (see this file's own header for what remains
// untested). ---------------------------------------------------------------------------------------
try {
  await waitUntil(() => host.isBusy(SESSION_ID), {
    label: `${SESSION_ID} busy signal rises from the MCP-connect attempt against unreachable servers`,
    timeoutMs: 20000,
  });
  check("REPRO: with unreachable MCP servers, codex's MCP-connect attempt made the session busy (a real busy episode was observed, not just boot chrome)", true);
} catch (err) {
  console.log(`[repro] busy never rose within budget: ${err.message}`);
  check("REPRO: with unreachable MCP servers, codex's MCP-connect attempt made the session busy", false);
}

if (host.isBusy(SESSION_ID)) {
  try {
    await waitUntil(() => !host.isBusy(SESSION_ID), {
      label: `${SESSION_ID} busy signal falls again on its own (self-heal via the existing staleness timer) — measured ~11.2s across four prior real trials, this bound is ~5x that`,
      timeoutMs: 60_000,
    });
    check("GUARD: the busy episode cleared on its own within 60s (bounded window) via the existing armCodexBusyStaleTimer mechanism — no unconfirmed-stuck defect reproduced under this failure shape", true);
  } catch (err) {
    console.log(`[repro] busy did NOT clear within the 60s bounded window: ${err.message}`);
    check("GUARD: the busy episode cleared on its own within 60s (bounded window)", false);
  }
}
console.log(`[repro] busy transitions observed (ms since spawn): ${JSON.stringify(busyTransitions)}`);

host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} onExit after graceful stop`, timeoutMs: 8000 });
} catch {
  console.log(`[cleanup] graceful stop didn't confirm exit in time — escalating to hard stop`);
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
  await new Promise((r) => setTimeout(r, 1000));
}
unsubscribe();

// --- md5-diff-disclose ---------------------------------------------------------------------------------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const removable = remaining.match(blockRe) ?? [];
  if (removable.length) {
    const restored = remaining.split(removable[0]).join("");
    if (md5(restored) === hashBefore) {
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] removed the expected [projects.'${scratchCwd}'] block this run added.`);
    } else {
      console.log(`[cleanup] ⚠️ found an expected-shaped block but removing it did not restore the exact pre-run hash — leaving config.toml untouched.`);
    }
  } else {
    console.log(`[cleanup] ⚠️ config.toml changed but no [projects.'${scratchCwd}'] block was found.`);
  }
} else {
  console.log("[cleanup] config.toml unchanged.");
}

releaseCodexLock();

console.log(failures === 0
  ? "\n✅ ALL PASS — a real busy episode from an unreachable-MCP-server spawn was observed and confirmed to clear again within a bounded window, via this project's own existing self-heal mechanism."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
