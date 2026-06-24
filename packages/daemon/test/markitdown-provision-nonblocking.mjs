import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Markitdown provisioning is NON-BLOCKING — the regression test for the event-loop-freeze blocker.
//
// THE BUG (caught in review): the cold-provision path ran SYNCHRONOUS spawnSync (venv create ≤120s + pip
// install markitdown-mcp markitdown[all] ≤180s) from buildMcpServers INSIDE the synchronous spawn path
// (createPty). The FIRST documentConversion spawn on a cold venv would FREEZE the whole daemon — every
// other spawn/resume, the web UI, all HTTP/MCP — for the entire install. The other hermetic tests never hit
// it because LOOM_MARKITDOWN_BIN bypasses provisioning.
//
// THE FIX (asserted here): the spawn HOT PATH does ONLY fs.existsSync(loomVenvBin(...)) — instant, no child
// process. When the venv is ABSENT it returns null FAST (the spawn skips the markitdown MCP, like
// Playwright's missing-cli fallback) and KICKS background provisioning via async child_process.spawn — never
// blocking the event loop. This test drives the venv-ABSENT path with a temp LOOM_HOME and
// LOOM_PYTHON_NO_PROVISION=1 (the provisioning seam is disabled, so CI builds NO real venv + hits NO
// network) and asserts: resolves null promptly, the map omits `markitdown` (byte-identical to OFF), the
// async provision was triggered, and NO real venv dir was created.
//
// Run: 1) build, 2) node test/markitdown-provision-nonblocking.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic: a temp LOOM_HOME with NO venv; the venv-resolution path (NOT the LOOM_MARKITDOWN_BIN
// override seam); provisioning DISABLED so no real venv/pip/network. Set BEFORE importing dist so paths.ts
// captures LOOM_HOME and host.ts's module state starts fresh. ---
const tmpHome = path.join(os.tmpdir(), `loom-mdprov-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_MARKITDOWN_BIN;        // exercise the venv path, not the fast override seam
process.env.LOOM_PYTHON_NO_PROVISION = "1";    // never build a real venv / run pip / hit the network in CI

const { buildMcpServers, markitdownMcpServer, __markitdownProvisionKicks } = await import("../dist/pty/host.js");
const { loomVenvDir, loomVenvBin } = await import("../dist/python/venv.js");

// Precondition: the shared venv binary really is absent (so we're on the cold path).
check("precondition: the shared venv markitdown binary is ABSENT (cold path)", !fs.existsSync(loomVenvBin("markitdown-mcp")));
check("precondition: no markitdown provision kicked yet", __markitdownProvisionKicks() === 0);

// (1) The spawn hot path resolves to null PROMPTLY — no blocking spawnSync of venv-create/pip. The OLD code
// would block for many SECONDS here (venv create alone); the fixed hot path is a single fs.existsSync.
const t0 = performance.now();
const srv = markitdownMcpServer();
const elapsedMs = performance.now() - t0;
check("(1) markitdownMcpServer() returns null when the venv is absent", srv === null);
check(`(1) hot path returns FAST (<500ms; measured ${elapsedMs.toFixed(1)}ms) — no synchronous venv-create/pip`, elapsedMs < 500);

// (2) It KICKED background provisioning (the async trigger fired exactly once so far).
check("(2) background provisioning was triggered (async, off the hot path)", __markitdownProvisionKicks() === 1);

// (3) A documentConversion spawn OMITS the markitdown server while it provisions, and the map is otherwise
//     byte-identical to an OFF spawn (fully additive — turning the flag on adds nothing until the venv warms).
const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", documentConversion: true });
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", documentConversion: false });
check("(3) documentConversion ON omits 'markitdown' while the venv is cold", !("markitdown" in on));
check("(3) ON map is byte-identical to OFF (additive — no markitdown key until warm)", JSON.stringify(on) === JSON.stringify(off));

// (3b) Repeated spawns stay non-blocking and DEDUPE the kick (one-shot per process — concurrent
//      documentConversion spawns never launch parallel pip installs).
const t1 = performance.now();
for (let i = 0; i < 5; i++) markitdownMcpServer();
const elapsed5 = performance.now() - t1;
check(`(3b) five more cold resolves stay fast (<500ms total; measured ${elapsed5.toFixed(1)}ms)`, elapsed5 < 500);
check("(3b) the kick is deduped/one-shot (still exactly 1, no parallel installs)", __markitdownProvisionKicks() === 1);

// (4) Let the async provision job settle, then confirm NO real venv was created in CI (the disable seam
//     held — the background job did not build a venv or run pip).
await new Promise((r) => setTimeout(r, 100));
check("(4) NO real venv was created in CI (LOOM_PYTHON_NO_PROVISION honored — no venv/pip/network)", !fs.existsSync(loomVenvDir()));

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — markitdown provisioning is NON-BLOCKING: the spawn hot path is fs.existsSync-only (returns null fast when the venv is absent, omits the MCP byte-identically to OFF) and kicks deduped BACKGROUND provisioning off the event loop — no spawnSync venv/pip on the spawn path, no real venv/pip/network in CI."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
