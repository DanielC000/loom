// Card 0e83c855 round 4 — DoD-2: the real-spawn, byte-level DoD for `codexAsciiFold`'s wiring into
// `submitCodex`. This is the PRIMARY acceptance check for the WIRING (does submitCodex actually apply the
// fold, does a real codex-cli process actually receive the folded result) — the hermetic
// codex-host-decisions.mjs file already pins the pure BOUNDARY logic itself against hardcoded expected
// strings; this file exists because that alone never proves anything reaches a real process.
//
// REPLACES the now-reverted file-delivery workaround's own real-spawn test
// (codex-prompt-file-delivery-real-spawn.mjs — see the sibling revert commit's own message for why that
// approach was abandoned). Same technique, different expected outcome: ask codex, via a prompt that
// EMBEDS the specimen, to write that specimen VERBATIM to a file in its own cwd, then byte-compare —
// except now the expected content is `codexAsciiFold(SPECIMEN)`, not the raw specimen, since the fold is
// applied BEFORE the text ever reaches codex's TUI (unlike file-delivery, which bypassed the TUI paste
// path entirely for non-ASCII text).
//
// BOTH POLARITIES in one specimen/assertion: SPECIMEN mixes the MEASURED-DROPPING class (em dash,
// no-entry, warning+VS16, an uncurated symbol) with the MEASURED-SURVIVING class (a Latin letter with
// diacritic, Cyrillic, CJK, an astral emoji) — the single byte-exact comparison against
// `codexAsciiFold(SPECIMEN)` proves both at once: the dropping class arrives FOLDED (not silently missing,
// which is what a RED run against pre-round-4 code would show — the raw specimen's dropping-class
// codepoints would simply be ABSENT from what codex received, not replaced by their fold substitutes, so
// the byte-exact comparison against the FOLDED expectation would fail), and the surviving class arrives
// UNTOUCHED.
//
// ⚠️ Genuinely needs the REAL, installed, authenticated `codex` CLI — SKIPS gracefully (exit 0, but with
// a WARN line so a skip is never silently indistinguishable from a pass — card 5978735a's own convention)
// if it isn't available on this host. Mirrors every sibling real-spawn file's own posture exactly.
//
// Safety: runs against the REAL ~/.codex (a sandboxed CODEX_HOME breaks auth), applying the SAME
// md5-before/diff-after/disclose discipline every sibling real-spawn file uses — this VERIFIES this
// project's own diffConfigAfterSpawn/removeAddedTrustBlocks cleanup, not a hand-rolled reimplementation.
//
// SEQUENCING: this file's own basename is registered in `CODEX_REAL_SPAWN_BASENAMES`
// (`_codex-real-spawn-lock.mjs`) — `codex-real-spawn-lock-membership-guard.mjs` fails the gate if that
// ever falls out of sync with this file's `acquireCodexRealSpawnLock()` call below.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-prompt-ascii-fold-real-spawn.mjs
import "./_guard.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// --- Graceful skip: needs a REAL, authenticated codex install — no fixture substitute. -----------------
try {
  await execFileAsync(codexBin, ["login", "status"], { timeout: 10000, windowsHide: true, shell: process.platform === "win32" });
} catch (e) {
  console.log(`WARN  SKIP  codex-prompt-ascii-fold-real-spawn.mjs — real, authenticated codex CLI not available on this host (${e.message.split("\n")[0]}). This test has no fixture substitute; it is real coverage only on a host with codex installed + logged in.`);
  process.exit(0);
}

const TMP = mkdtempManaged("loom-codex-ascii-fold-real-");
process.env.LOOM_HOME = TMP;

const { PtyHost } = await import("../dist/pty/host.js");
const { codexAsciiFold } = await import("../dist/pty/codex-host.js");

const SESSION_ID = "codex-ascii-fold-real-test";
const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-codex-ascii-fold-real-cwd-"));

// --- md5-before (real ~/.codex/config.toml) -----------------------------------------------------------
const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
const readConfig = () => { try { return fs.readFileSync(CONFIG_PATH, "utf8"); } catch { return ""; } };
const configBefore = readConfig();
const hashBefore = configBefore ? md5(configBefore) : "ENOENT";

const releaseCodexLock = await acquireCodexRealSpawnLock();

const exitedSessions = new Map();
const events = {
  onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {},
  onExit(sessionId, code, info) { exitedSessions.set(sessionId, { code, intended: info.intended }); },
};
const host = new PtyHost(events);

let buf = "";
host.spawn({
  sessionId: SESSION_ID, cwd: scratchCwd, permission: {}, geometry: { cols: 120, rows: 40 },
  sessionEnv: {}, role: "worker", harness: "codex",
});
const unsubscribe = host.subscribe(SESSION_ID, {
  onData: (chunk) => { buf += chunk.toString("utf-8"); },
  onControl: () => {},
});

// --- Boot + trust-dialog + ready — mirrors every sibling real-spawn file's own discipline exactly. -----
try {
  await waitUntil(() => host.isCodexBootReady(SESSION_ID) && !host.isBusy(SESSION_ID), {
    label: `${SESSION_ID} real codex reaches full boot readiness AND settles idle`,
    timeoutMs: 20000,
  });
} catch (err) {
  console.log(`FAIL  real codex never reached an idle, boot-ready state within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}

// --- THE REAL TURN: a prompt that EMBEDS a specimen mixing the MEASURED-DROPPING class (em dash,
// no-entry, warning+VS16, an uncurated symbol) with the MEASURED-SURVIVING class (Latin+diacritic,
// Cyrillic, CJK, astral emoji) — submitCodex MUST fold only the first half. -----------------------------
const SPECIMEN = "run — stop ⛔ caution ⚠️ degree° café привет 中文 🔴red";
// (— em dash, ⛔ no-entry, ⚠+️ warning+VS16, ° degree sign [deliberately NOT in
// the curated table — exercises the generic '?' fallback], é e-acute [a LETTER], р... Cyrillic
// [LETTERs], 中文 CJK [LETTERs], 🔴 red-circle [astral, a surrogate pair].)
const EXPECTED_CONTENT = codexAsciiFold(SPECIMEN);
check("SPECIMEN genuinely contains the measured-dropping class (this turn's fold must actually do something, not be a no-op)", SPECIMEN !== EXPECTED_CONTENT);
check("EXPECTED_CONTENT preserves every LETTER/astral codepoint from SPECIMEN untouched", EXPECTED_CONTENT.includes("café") && EXPECTED_CONTENT.includes("привет") && EXPECTED_CONTENT.includes("中文") && EXPECTED_CONTENT.includes("🔴"));
check("EXPECTED_CONTENT no longer contains any of the raw dropping-class codepoints (they were folded, not merely passed through)", !EXPECTED_CONTENT.includes("—") && !EXPECTED_CONTENT.includes("⛔") && !EXPECTED_CONTENT.includes("⚠") && !EXPECTED_CONTENT.includes("°"));

const OUTPUT_FILENAME = "ascii-fold-output.txt";
const PROMPT = `Create a file named ${OUTPUT_FILENAME} in your current working directory. Its content must be EXACTLY the following text, byte for byte, verbatim, with no other characters added before or after it (a single trailing newline is fine if your tool adds one automatically, but add nothing else):\n\n${SPECIMEN}`;
check("PROMPT genuinely contains non-ASCII (this turn exercises the real submit path, not a pure-ASCII no-op)", /[^\x00-\x7f]/.test(PROMPT));

const enq = host.enqueueStdin(SESSION_ID, PROMPT, "system", undefined, undefined, "agent");
check("enqueueStdin delivered the one real turn immediately (session was idle post-boot)", enq.delivered === true);

// --- Wait for the real turn to complete (idle again), then check what codex ACTUALLY WROTE. ------------
try {
  await waitUntil(() => host.isBusy(SESSION_ID) === false, {
    label: `${SESSION_ID} the real turn completes and codex goes idle again`,
    timeoutMs: 60000,
  });
} catch (err) {
  console.log(`FAIL  the real turn never went idle within budget: ${err.message}`);
  console.log(`--- captured output tail ---\n${buf.slice(-2000)}`);
  failures++;
}

// --- THE DECISIVE ASSERTION: codex's OWN written output, byte-compared against codexAsciiFold(SPECIMEN)
// — not the raw specimen. On pre-round-4 code (no fold, direct write), codex would receive the raw
// specimen with its dropping-class codepoints simply ABSENT (not replaced), so this comparison would FAIL
// — a genuine RED-before-GREEN-after signal, not merely a check that engages without discriminating. ----
const outputPath = path.join(scratchCwd, OUTPUT_FILENAME);
let outputExists = fs.existsSync(outputPath);
if (!outputExists) {
  try {
    await waitUntil(() => fs.existsSync(outputPath), { label: `${OUTPUT_FILENAME} appears in the real codex cwd`, timeoutMs: 10000 });
    outputExists = true;
  } catch { /* still checked, and reported, below */ }
}
check(`codex actually created ${OUTPUT_FILENAME} in its cwd (demonstrable action on the delivered text, not just a reply)`, outputExists);

if (outputExists) {
  const written = fs.readFileSync(outputPath, "utf8");
  const strippedTrailingNewline = written.replace(/\r?\n$/, "");
  console.log(`[info] codex's own written output (raw): ${JSON.stringify(written)}`);
  console.log(`[info] expected (folded) content:        ${JSON.stringify(EXPECTED_CONTENT)}`);
  check("BYTE-EXACT against the FOLDED expectation (allowing at most one trailing newline): codex received the fold, not the raw specimen and not silence", strippedTrailingNewline === EXPECTED_CONTENT || written === EXPECTED_CONTENT);
  // Per-codepoint breakdown — mirrors the file-delivery test's own diagnostic shape, so a partial failure
  // names EXACTLY which class broke rather than a single opaque boolean.
  check("codepoint U+2014 (em dash) is ABSENT from codex's output (it was folded to '--', not passed through raw)", !written.includes("—"));
  check("codepoint U+26D4 (no-entry) is ABSENT from codex's output (folded to '[X]')", !written.includes("⛔"));
  check("codepoint U+26A0 (warning) is ABSENT from codex's output (folded to '[!]')", !written.includes("⚠"));
  check("the fold substitutes '--', '[X]', '[!]' ARE present in codex's output", written.includes("--") && written.includes("[X]") && written.includes("[!]"));
  check("the generic '?' fallback fired for the uncurated degree sign", written.includes("?"));
  check("codepoint U+00E9 (e-acute, a LETTER) SURVIVED into codex's output untouched", written.includes("café"));
  check("Cyrillic text SURVIVED into codex's output untouched", written.includes("привет"));
  check("CJK text SURVIVED into codex's output untouched", written.includes("中文"));
  check("the astral emoji U+1F534 (surrogate pair, not split/corrupted) SURVIVED into codex's output untouched", written.includes("🔴"));
}

// --- stop() — mirrors every sibling real-spawn file's own timed graceful-stop discipline. ---------------
const stopStartedAt = Date.now();
host.stop(SESSION_ID, "graceful");
try {
  await waitUntil(() => exitedSessions.has(SESSION_ID), { label: `${SESSION_ID} real codex process onExit after graceful stop`, timeoutMs: 8000 });
  const exit = exitedSessions.get(SESSION_ID);
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (code=${exit.code}, intended=${exit.intended})`);
  check("the real codex process exited with code 0 (clean shutdown)", exit.code === 0);
} catch (err) {
  console.log(`[info] stop->exit elapsed: ${Date.now() - stopStartedAt}ms (never observed onExit within budget)`);
  console.log(`FAIL  real codex never reported onExit within budget after graceful stop: ${err.message}`);
  failures++;
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort cleanup */ }
}
check("host.isAlive reports false once the real codex process has exited", host.isAlive(SESSION_ID) === false);
unsubscribe();

// --- md5-diff-disclose: confirm THIS PROJECT'S OWN cleanup restored config.toml, not a test-local
// reimplementation of that logic. Mirrors every sibling real-spawn file's own settle-poll exactly. -------
let hashAfter = readConfig();
hashAfter = hashAfter ? md5(hashAfter) : "ENOENT";
await waitUntil(() => {
  const c = readConfig();
  const h = c ? md5(c) : "ENOENT";
  const settled = h === hashAfter;
  hashAfter = h;
  return settled;
}, { timeoutMs: 3000, intervalMs: 250 }).catch(() => { /* best-effort settle wait — the check below still reports the truth either way */ });

if (hashAfter !== hashBefore) {
  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`\\[projects\\.'${escapeRegex(scratchCwd.toLowerCase())}'\\][^\\[]*`, "gi");
  const remaining = readConfig();
  const stillPresent = blockRe.test(remaining);
  check("THIS PROJECT'S OWN removeAddedTrustBlocks already stripped the expected [projects.'<scratchCwd>'] block (no manual cleanup needed)", !stillPresent);
  if (stillPresent) {
    const removable = remaining.match(blockRe) ?? [];
    if (removable.length) {
      const restored = remaining.split(removable[0]).join("");
      fs.writeFileSync(CONFIG_PATH, restored);
      console.log(`[cleanup] manually removed the block THIS PROJECT'S OWN code should have already stripped: ${removable[0]}`);
    }
  }
} else {
  console.log("[cleanup] config.toml unchanged (this scratch cwd was likely already trusted from a prior run, or the diff genuinely found nothing to clean).");
}

releaseCodexLock();

console.log(failures === 0
  ? "\n✅ ALL PASS — codexAsciiFold's wiring into submitCodex (card 0e83c855 round 4) proven against a REAL, authenticated codex-cli process: a prompt embedding em dash/no-entry/warning+VS16/an uncurated degree sign alongside a LETTER-with-diacritic/Cyrillic/CJK/astral-emoji control set was submitted through the real submit path, and codex's own written output — byte-compared against codexAsciiFold(SPECIMEN), not the raw specimen — shows the dropping class arrived FOLDED (curated substitutes '--'/'[X]'/'[!]' and a generic '?' fallback for the uncurated case) while every letter/astral control codepoint arrived byte-identical, untouched."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
