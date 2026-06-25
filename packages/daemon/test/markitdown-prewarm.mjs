import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Markitdown venv PRE-WARM — closes the provision-on-first-spawn cold-skip window (card 72942973).
//
// THE GAP: provisioning the shared venv is async/background (correctly non-blocking — see
// markitdown-provision-nonblocking.mjs). But on a fresh machine the FIRST session under a
// documentConversion profile KICKS provisioning and spawns WITHOUT the markitdown MCP; only a LATER spawn
// picks the tool up once the venv warms (~1.5 min). The fix pre-warms the venv EARLIER — at daemon boot if
// any profile opts in, and when a profile is SAVED with documentConversion=true — by reusing the SAME
// deduped async background kick the spawn path uses (`prewarmMarkitdown` → resolveMarkitdownBin →
// kickMarkitdownProvision).
//
// THIS TEST (hermetic): a temp LOOM_HOME with NO venv + LOOM_PYTHON_NO_PROVISION=1 (the provisioning seam is
// disabled, so CI builds NO real venv + hits NO network), driving the venv-resolution path (NOT the
// LOOM_MARKITDOWN_BIN override seam). It asserts: (a) the interpreter resolver picks the first project that
// sets python.interpreterPath, else undefined; (b) the boot pre-warm does NOTHING when no profile wants
// documentConversion; (c) it KICKS the background provision when a profile DOES — the same kick the REST
// profile-save handler (gateway prewarmMarkitdown) fires; (d) the kick is deduped/one-shot; (e) no real venv
// is built. NO real provisioning / network runs.
//
// Run: 1) build, 2) node test/markitdown-prewarm.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic: temp LOOM_HOME with NO venv; venv-resolution path (not the override seam); provisioning
// DISABLED. Set BEFORE importing dist so paths.ts captures LOOM_HOME and host.ts module state starts fresh. ---
const tmpHome = path.join(os.tmpdir(), `loom-mdprewarm-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_MARKITDOWN_BIN;     // exercise the venv path, not the fast override seam
process.env.LOOM_PYTHON_NO_PROVISION = "1"; // never build a real venv / run pip / hit the network in CI

const { prewarmMarkitdown, prewarmMarkitdownForProfilesAtBoot, resolvePrewarmInterpreterPath } = await import("../dist/python/prewarm.js");
const { __markitdownProvisionKicks } = await import("../dist/pty/host.js");
const { loomVenvDir, loomVenvBin } = await import("../dist/python/venv.js");

// Preconditions: cold venv, nothing kicked yet.
check("precondition: the shared venv markitdown binary is ABSENT (cold path)", !fs.existsSync(loomVenvBin("markitdown-mcp")));
check("precondition: no markitdown provision kicked yet", __markitdownProvisionKicks() === 0);

// (a) resolvePrewarmInterpreterPath — PURE (no kick): first project that sets python.interpreterPath, else
//     undefined. python.interpreterPath is per-project (no platform-override layer), so this is the choice.
check("(a) no projects → undefined", resolvePrewarmInterpreterPath([]) === undefined);
check("(a) projects but none set interpreterPath → undefined",
  resolvePrewarmInterpreterPath([{ config: undefined }, { config: { python: {} } }]) === undefined);
check("(a) picks the FIRST project that sets interpreterPath",
  resolvePrewarmInterpreterPath([
    { config: undefined },
    { config: { python: { interpreterPath: "/opt/py-a/bin/python3" } } },
    { config: { python: { interpreterPath: "/opt/py-b/bin/python3" } } },
  ]) === "/opt/py-a/bin/python3");
// still no kick — the resolver is pure.
check("(a) the interpreter resolver kicked NOTHING (pure)", __markitdownProvisionKicks() === 0);

// (b) Boot pre-warm is a NO-OP when no profile opts into documentConversion.
const dbNoDoc = {
  listProfiles: () => [{ documentConversion: false }, { documentConversion: undefined }, {}],
  listAllProjects: () => [{ config: undefined }],
};
check("(b) boot pre-warm returns false when no profile wants documentConversion", prewarmMarkitdownForProfilesAtBoot(dbNoDoc) === false);
check("(b) boot pre-warm with no doc-conv profile kicked NOTHING", __markitdownProvisionKicks() === 0);

// (c) Boot pre-warm KICKS the background provision when a profile DOES opt in. This is the same async,
//     deduped kick the REST profile-save handler (gateway → prewarmMarkitdown) fires.
const dbWithDoc = {
  listProfiles: () => [{ documentConversion: false }, { documentConversion: true }],
  listAllProjects: () => [{ config: { python: { interpreterPath: "/opt/py-a/bin/python3" } } }],
};
check("(c) boot pre-warm returns true when a profile wants documentConversion", prewarmMarkitdownForProfilesAtBoot(dbWithDoc) === true);
check("(c) boot pre-warm KICKED background provisioning (off the event loop)", __markitdownProvisionKicks() === 1);

// (d) Deduped / one-shot: a second boot pre-warm AND a direct profile-save-style prewarmMarkitdown both
//     no-op the kick (concurrent docConversion saves never launch parallel pip installs).
check("(d) a second boot pre-warm still reports a wanted profile (true)", prewarmMarkitdownForProfilesAtBoot(dbWithDoc) === true);
prewarmMarkitdown("/opt/py-a/bin/python3"); // the exact call the REST POST/PUT handler makes
check("(d) the kick stayed deduped/one-shot (still exactly 1, no parallel installs)", __markitdownProvisionKicks() === 1);

// (e) Let any async job settle, then confirm NO real venv was built (the disable seam held).
await new Promise((r) => setTimeout(r, 100));
check("(e) NO real venv was created in CI (LOOM_PYTHON_NO_PROVISION honored — no venv/pip/network)", !fs.existsSync(loomVenvDir()));

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the markitdown venv is PRE-WARMED off the hot path: the interpreter resolver picks the first project that sets python.interpreterPath (else undefined), boot no-ops when no profile wants documentConversion, and a wanting profile (boot OR REST profile-save) fires the SAME deduped async background kick — no real venv/pip/network in CI."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
