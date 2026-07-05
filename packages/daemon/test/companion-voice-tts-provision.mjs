import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — VOICE-P3 TTS PROVISIONING (companion/tts.ts's own memoized-ready + deduped-background
// + retry-after-terminal-outcome discipline), mirroring the shipped STT/markitdown provisioning tests.
// Fully hermetic:
//   (1) LOOM_PYTHON_NO_PROVISION=1 is honored end-to-end through the REAL ensurePythonPackageAsync (no
//       test-seam override) — isReady() resolves false promptly, no real venv is ever created, no network.
//   (2) concurrent isReady() calls DEDUPE the background provision kick (one in-flight call, not N).
//   (3) a TERMINAL failure (not "ready") allows a FRESH kick on the next call — never a permanent dead-end.
// Run: 1) build, 2) node test/companion-voice-tts-provision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic: a temp LOOM_HOME with no venv; set BEFORE importing dist so paths.ts/venv.ts capture it fresh.
const tmpHome = path.join(os.tmpdir(), `loom-ttsprov-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PYTHON_NO_PROVISION = "1"; // never build a real venv / run pip / hit the network in CI

const {
  createKokoroSynthesizer,
  __setTtsProvisionerForTest,
  __setTtsPythonBinForTest,
} = await import("../dist/companion/tts.js");
const { loomVenvDir } = await import("../dist/python/venv.js");

try {
  // ============ 1 — LOOM_PYTHON_NO_PROVISION honored through the REAL provisioner ============================
  {
    __setTtsProvisionerForTest(); // ensure the REAL ensurePythonPackageAsync is wired (no fake)
    const synth = createKokoroSynthesizer();
    const ready1 = synth.isReady();
    check("1: isReady() is false on a cold venv with provisioning disabled", ready1 === false);
    await new Promise((r) => setTimeout(r, 100)); // let the (disabled, near-instant) kick settle
    const ready2 = synth.isReady();
    check("1: isReady() stays false after the disabled kick settles", ready2 === false);
    check("1: NO real venv was created (LOOM_PYTHON_NO_PROVISION honored — no venv/pip/network)", !fs.existsSync(loomVenvDir()));
  }

  // ============ 2 — concurrent isReady() calls DEDUPE the background provision kick ===========================
  {
    let calls = 0;
    let resolveProvision;
    __setTtsProvisionerForTest(() => {
      calls++;
      return new Promise((r) => { resolveProvision = r; });
    });
    const synth = createKokoroSynthesizer();
    // Five back-to-back readiness checks while the (fake) provision is still in-flight.
    for (let i = 0; i < 5; i++) synth.isReady();
    check("2: exactly ONE provision call in flight despite 5 readiness checks (deduped)", calls === 1);
    resolveProvision({ binary: null, outcome: "pip-failed", errorTail: "simulated" });
    await new Promise((r) => setTimeout(r, 20)); // let the in-flight promise's .then/.finally settle
  }

  // ============ 3 — a TERMINAL failure allows a FRESH kick next time (never a permanent dead-end) =============
  {
    __setTtsPythonBinForTest(undefined); // clear any memoized bin from a prior section
    let calls = 0;
    __setTtsProvisionerForTest(async () => {
      calls++;
      return calls === 1
        ? { binary: null, outcome: "pip-failed", errorTail: "simulated first failure" }
        : { binary: "/fake/venv/python", outcome: "ready" };
    });
    const synth = createKokoroSynthesizer();
    check("3: not ready on the first (failing) attempt", synth.isReady() === false);
    await new Promise((r) => setTimeout(r, 20)); // let the failed kick's .then/.finally clear in-flight state
    check("3: still not ready right after the failure (this call ALSO kicks a fresh attempt)", synth.isReady() === false);
    await new Promise((r) => setTimeout(r, 20)); // let the second (successful) kick's .then set the memoized bin
    check("3: a THIRD call is now ready — retried after a terminal failure, never a permanent dead-end", synth.isReady() === true);
    check("3: exactly two provision attempts were made (the first failure, then the retry)", calls === 2);
  }
} catch (err) {
  console.error("UNCAUGHT:", err);
  failures++;
} finally {
  __setTtsProvisionerForTest(); // restore the real provisioner for any later import in this process
  __setTtsPythonBinForTest(undefined);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
