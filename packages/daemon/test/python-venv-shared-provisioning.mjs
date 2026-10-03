import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3fbf878b: python/venv.ts had NO module-level lock, so markitdown / companion STT / companion TTS
// provisioning (each with its OWN separate in-flight dedupe — markitdownProvisionInFlight / sttProvisionInFlight
// / ttsProvisionInFlight, in THREE different files) could each independently call `ensurePythonPackageAsync`
// on a cold boot and race concurrent `python -m venv` invocations into the SAME `<LOOM_HOME>/python/venv`
// directory, then race concurrent `pip install` runs into the same site-packages once it existed. Separately,
// the fast path only checked `fs.existsSync(venvPython())` — a venv whose `python -m venv` was interrupted
// AFTER unpacking python but BEFORE finishing pip never self-healed: every later call saw "ready" and just
// kept failing pip install forever.
//
// THE FIX (asserted here): `ensureLoomVenvAsync` now shares ONE in-flight venv-create promise per venv dir
// (so N concurrent consumers produce exactly ONE `python -m venv` invocation, never overlapping), its fast
// path probes for BOTH python AND pip and wipes+recreates a half-built venv instead of trusting it, and
// `ensurePythonPackageAsync`'s own pip-install step runs behind a per-dir serialization queue (so N concurrent
// consumers each still get their OWN `pip install`, but never two running at the same time against the same
// venv).
//
// HERMETIC: a temp LOOM_HOME with no real venv, and node:child_process.spawn replaced via venv.ts's own
// `__setSpawnForTest` seam with a fake child that never touches a real process, real venv, real pip, or the
// network — only in-memory bookkeeping plus writing small stub files to simulate what a real `python -m venv`
// / `pip install` would leave behind.
//
// Run: 1) build, 2) node test/python-venv-shared-provisioning.mjs
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = mkdtempManaged("loom-pyvenv-");
delete process.env.LOOM_PYTHON_NO_PROVISION; // we WANT the real (fake-spawn-backed) provisioning path to run
delete process.env.LOOM_MARKITDOWN_BIN;
requireHermeticEnv();

const {
  ensurePythonPackageAsync, loomVenvDir, loomVenvBin,
  __setSpawnForTest, __resetVenvProvisionStateForTest,
} = await import("../dist/python/venv.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const isWin = process.platform === "win32";
const venvDir = loomVenvDir();
const pyPath = path.join(venvDir, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");
const pipPath = path.join(venvDir, isWin ? "Scripts" : "bin", isWin ? "pip.exe" : "pip");

function writeStub(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ===================== fake spawn harness =====================
const PKG_TO_BIN = { "pkg-markitdown": "bin-markitdown", "pkg-stt": "bin-stt", "pkg-tts": "bin-tts", "pkg-heal": "bin-heal" };
const VENV_STEP_DELAY_MS = 25; // real elapsed time so a non-deduped race would actually OVERLAP, not just interleave on microtasks
const PIP_STEP_DELAY_MS = 25;

let venvCreateCalls = 0, venvCreateActive = 0, venvCreateMaxConcurrent = 0;
let pipInstallCalls = 0, pipInstallActive = 0, pipInstallMaxConcurrent = 0;

function fakeSpawn(command, args) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const exit = (code) => setImmediate(() => child.emit("exit", code));

  if (args.includes("--version")) {
    // Base-python discovery: only the FIRST candidate (`python3`) succeeds, so discoverBasePythonAsync never
    // tries a second candidate and this harness only ever needs to model one command name.
    setImmediate(() => exit(command === "python3" ? 0 : 1));
    return child;
  }

  if (args.includes("venv")) {
    venvCreateCalls++; venvCreateActive++;
    venvCreateMaxConcurrent = Math.max(venvCreateMaxConcurrent, venvCreateActive);
    const dir = args[args.length - 1];
    setTimeout(() => {
      venvCreateActive--;
      writeStub(path.join(dir, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python"), "FRESH-PY");
      writeStub(path.join(dir, isWin ? "Scripts" : "bin", isWin ? "pip.exe" : "pip"), "FRESH-PIP");
      exit(0);
    }, VENV_STEP_DELAY_MS);
    return child;
  }

  if (args.includes("install")) {
    pipInstallCalls++; pipInstallActive++;
    pipInstallMaxConcurrent = Math.max(pipInstallMaxConcurrent, pipInstallActive);
    const pkgs = args.slice(args.indexOf("install") + 1);
    setTimeout(() => {
      pipInstallActive--;
      // Model reality: a `pip install` against a venv whose OWN pip isn't actually there fails — this is
      // what makes the half-built-venv scenario below a genuine RED/GREEN discriminator, not a tautology.
      if (!fs.existsSync(pipPath)) {
        child.stderr.emit("data", Buffer.from("ModuleNotFoundError: No module named 'pip'\n"));
        exit(1);
        return;
      }
      for (const pkg of pkgs) {
        const bin = PKG_TO_BIN[pkg];
        if (bin) writeStub(loomVenvBin(bin), `INSTALLED:${pkg}`);
      }
      exit(0);
    }, PIP_STEP_DELAY_MS);
    return child;
  }

  if (args[0] === "-c") {
    // import probe — not exercised by this test (no probeImport passed), but handled for completeness.
    setImmediate(() => exit(0));
    return child;
  }

  setImmediate(() => exit(0));
  return child;
}

__setSpawnForTest(fakeSpawn);

// ===================== (1) three concurrent cold consumers (markitdown / STT / TTS analogue) =====================
const [r1, r2, r3] = await Promise.all([
  ensurePythonPackageAsync({ package: "pkg-markitdown", binary: "bin-markitdown" }),
  ensurePythonPackageAsync({ package: "pkg-stt", binary: "bin-stt" }),
  ensurePythonPackageAsync({ package: "pkg-tts", binary: "bin-tts" }),
]);

check("(1) all three concurrent consumers resolve ready", [r1, r2, r3].every((r) => r.outcome === "ready"));
check("(1) each resolves its OWN distinct binary", r1.binary === loomVenvBin("bin-markitdown") && r2.binary === loomVenvBin("bin-stt") && r3.binary === loomVenvBin("bin-tts"));
check(`(1) venv creation happened exactly ONCE across 3 concurrent consumers (measured ${venvCreateCalls})`, venvCreateCalls === 1);
check(`(1) venv creation never ran concurrently with itself (measured max concurrent = ${venvCreateMaxConcurrent})`, venvCreateMaxConcurrent === 1);
check(`(1) pip install ran once per package — 3 total (measured ${pipInstallCalls})`, pipInstallCalls === 3);
check(`(1) pip installs were SERIALIZED, never run concurrently (measured max concurrent = ${pipInstallMaxConcurrent})`, pipInstallMaxConcurrent === 1);

// ===================== (2) a half-built venv (python present, pip missing — an interrupted create) self-heals =====================
venvCreateCalls = 0; venvCreateMaxConcurrent = 0; pipInstallCalls = 0; pipInstallMaxConcurrent = 0;
fs.rmSync(venvDir, { recursive: true, force: true });
writeStub(pyPath, "STALE-PY"); // python present...
check("(2) precondition: half-built venv has python but NOT pip", fs.existsSync(pyPath) && !fs.existsSync(pipPath));

const r4 = await ensurePythonPackageAsync({ package: "pkg-heal", binary: "bin-heal" });
check(`(2) a half-built venv is detected and REPAIRED rather than trusted as ready (outcome=${r4.outcome})`, r4.outcome === "ready" && r4.binary === loomVenvBin("bin-heal"));
check(`(2) repairing required an actual venv re-create, not a silent no-op (measured ${venvCreateCalls} create call(s))`, venvCreateCalls === 1);
check("(2) the recreated python is the FRESH stub, not the stale half-built one", fs.existsSync(pyPath) && fs.readFileSync(pyPath, "utf-8") === "FRESH-PY");
check("(2) pip is present after the repair", fs.existsSync(pipPath));

// ===================== cleanup =====================
__resetVenvProvisionStateForTest();
try { fs.rmSync(venvDir, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — venv creation is deduped to ONE shared in-flight create across concurrent consumers (never racing `python -m venv` into the same dir), pip installs are serialized per venv dir (never running concurrently), and a half-built venv (python present, pip missing) is detected and repaired instead of trusted as ready."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
