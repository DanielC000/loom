import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Voice opt-in gate (owner-directed 2026-07-06): `platform.companionVoiceEnabled` — default
// OFF — must make voice provisioning fully inert until a human flips it on. Fully hermetic: NO daemon, NO
// claude, NO real venv/pip/network (LOOM_PYTHON_NO_PROVISION=1 + a fake provisioner test seam). Covers:
//   (1) OFF: createFasterWhisperTranscriber(..., false).isReady() is false and NEVER calls the provisioner
//       (no venv provisioning kicked); transcribe() resolves null without calling the provisioner either.
//   (2) OFF: createKokoroSynthesizer(..., false) — the same shape, mirrored for TTS.
//   (3) ON (default true / explicit true): both factories behave exactly as before — isReady() kicks the
//       (fake) provisioner and flips ready once it resolves.
//   (4) shouldPrewarmCompanionVoice (python/prewarm.ts): the pure boot-gate decision table.
// Run: 1) build, 2) node test/companion-voice-enable-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-voicegate-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PYTHON_NO_PROVISION = "1"; // belt-and-suspenders: never touch the network even if a gate leaks

const {
  createFasterWhisperTranscriber,
  __setSttProvisionerForTest,
  __setSttPythonBinForTest,
} = await import("../dist/companion/stt.js");
const {
  createKokoroSynthesizer,
  __setTtsProvisionerForTest,
  __setTtsPythonBinForTest,
} = await import("../dist/companion/tts.js");
const { shouldPrewarmCompanionVoice } = await import("../dist/python/prewarm.js");

try {
  // ============ 1 — STT OFF: isReady()/transcribe() never touch the provisioner ============
  {
    let calls = 0;
    __setSttPythonBinForTest(undefined);
    __setSttProvisionerForTest(async () => { calls++; return { binary: "/fake/python", outcome: "ready" }; });
    const tr = createFasterWhisperTranscriber("/fake/interpreter", false);
    check("1: isReady() is false when disabled", tr.isReady() === false);
    const result = await tr.transcribe({ filePath: "/tmp/x.ogg", langHint: null });
    check("1: transcribe() resolves null when disabled", result === null);
    await new Promise((r) => setTimeout(r, 20));
    check("1: the provisioner was NEVER called (no venv provisioning kicked)", calls === 0);
  }

  // ============ 2 — TTS OFF: isReady()/synthesize() never touch the provisioner ============
  {
    let calls = 0;
    __setTtsPythonBinForTest(undefined);
    __setTtsProvisionerForTest(async () => { calls++; return { binary: "/fake/python", outcome: "ready" }; });
    const synth = createKokoroSynthesizer("/fake/interpreter", false);
    check("2: isReady() is false when disabled", synth.isReady() === false);
    const result = await synth.synthesize({ text: "hello there", lang: null, voice: null });
    check("2: synthesize() resolves null when disabled", result === null);
    await new Promise((r) => setTimeout(r, 20));
    check("2: the provisioner was NEVER called (no venv provisioning kicked)", calls === 0);
  }

  // ============ 3a — STT ON: behaves exactly as before (kicks + resolves ready) ============
  {
    let calls = 0;
    __setSttPythonBinForTest(undefined);
    __setSttProvisionerForTest(async () => { calls++; return { binary: "/fake/python", outcome: "ready" }; });
    const tr = createFasterWhisperTranscriber("/fake/interpreter", true);
    check("3a: isReady() false on the first (cold) call", tr.isReady() === false);
    await new Promise((r) => setTimeout(r, 20));
    check("3a: isReady() true once the (fake) provision resolves", tr.isReady() === true);
    check("3a: exactly one provision call", calls === 1);
  }

  // ============ 3b — TTS ON (the default, no 2nd arg): unchanged behavior ============
  {
    let calls = 0;
    __setTtsPythonBinForTest(undefined);
    __setTtsProvisionerForTest(async () => { calls++; return { binary: "/fake/python", outcome: "ready" }; });
    const synth = createKokoroSynthesizer("/fake/interpreter");
    check("3b: isReady() false on the first (cold) call", synth.isReady() === false);
    await new Promise((r) => setTimeout(r, 20));
    check("3b: isReady() true once the (fake) provision resolves", synth.isReady() === true);
    check("3b: exactly one provision call", calls === 1);
  }

  // ============ 4 — shouldPrewarmCompanionVoice: the pure boot-gate decision table ============
  {
    check("4: companion configured + voice enabled -> prewarm", shouldPrewarmCompanionVoice(true, true) === true);
    check("4: companion configured + voice disabled -> no prewarm", shouldPrewarmCompanionVoice(true, false) === false);
    check("4: no companion + voice enabled -> no prewarm", shouldPrewarmCompanionVoice(false, true) === false);
    check("4: no companion + voice disabled -> no prewarm", shouldPrewarmCompanionVoice(false, false) === false);
  }
} catch (err) {
  console.error("UNCAUGHT:", err);
  failures++;
} finally {
  __setSttProvisionerForTest();
  __setSttPythonBinForTest(undefined);
  __setTtsProvisionerForTest();
  __setTtsPythonBinForTest(undefined);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
