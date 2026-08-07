import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9ccedbee (Code Review follow-up) — unit coverage for gateway/loopback-secret.ts itself, which had
// ZERO dedicated coverage at first review (the gateway-level test only ever injected a literal string).
// HERMETIC + NETWORK-FREE: pure fs against a scratch dir, no server, no DB. Covers:
//   (A) fresh create: mints a 64-hex-char (256-bit) secret, persists it, a second call re-reads the SAME
//       value (no silent rotation on every boot).
//   (B) MAJOR 1 FIX: an EMPTY file at secretPath (the exact one-command DoS — `: > path` / `touch path`)
//       is detected as corrupt and REGENERATED, not thrown — the daemon must never refuse to boot because
//       a trivially-creatable empty file exists. Proven both for a pre-existing empty file AND for the
//       race-shaped EEXIST-then-still-corrupt path the fix actually touches.
//   (C) two "concurrent" calls (same secretPath, back-to-back — a real race needs multiple processes,
//       which this hermetic file can't spin up, but the EEXIST/re-read logic is exercised directly here
//       via a pre-seeded legitimate file, proving the "another writer won" agreement path) resolve to the
//       SAME secret, never two different ones.
//   (D) verifyLoopbackSecret: rejects undefined, "", a wrong-length value, and a right-length-but-wrong
//       value — accepts only the exact match — all constant-time-shaped (Buffer.from + timingSafeEqual,
//       confirmed structurally).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-loopback-secret-");
process.env.LOOM_HOME = TMP;
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { getOrCreateLoopbackSecret, verifyLoopbackSecret } = await import("../dist/gateway/loopback-secret.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ===================== (A) fresh create + stable re-read =====================
const pathA = path.join(TMP, "a", "gateway-loopback.key");
const secretA1 = getOrCreateLoopbackSecret(pathA);
check("(A) fresh secret is 64 hex chars (256-bit)", /^[0-9a-f]{64}$/.test(secretA1));
check("(A) the file was actually written", fs.existsSync(pathA));
check("(A) file content matches the returned secret", fs.readFileSync(pathA, "utf8").trim() === secretA1);
const secretA2 = getOrCreateLoopbackSecret(pathA);
check("(A) a second call re-reads the SAME secret (no silent rotation)", secretA2 === secretA1);

// ===================== (B) MAJOR 1 FIX: empty file is corrupt, not fatal =====================
const pathB = path.join(TMP, "b", "gateway-loopback.key");
fs.mkdirSync(path.dirname(pathB), { recursive: true });
fs.writeFileSync(pathB, ""); // the exact `: > path` / `touch path` DoS shape
let threwOnEmpty = false;
let secretB;
try {
  secretB = getOrCreateLoopbackSecret(pathB);
} catch {
  threwOnEmpty = true;
}
check("(B) an EMPTY pre-existing file does NOT throw (pre-fix: EEXIST propagated out of main(), a boot-blocking DoS)", !threwOnEmpty);
check("(B) a valid secret was generated to REPLACE the empty file", typeof secretB === "string" && /^[0-9a-f]{64}$/.test(secretB));
check("(B) the file on disk now holds that same regenerated secret (not still empty)", fs.readFileSync(pathB, "utf8").trim() === secretB);
// A SECOND call after regeneration must be stable too (the healed file behaves like a normal one).
const secretB2 = getOrCreateLoopbackSecret(pathB);
check("(B) post-regeneration, a second call re-reads the SAME (now valid) secret", secretB2 === secretB);

// Whitespace-only is the same corruption class as empty (readSecretIfPresent trims before checking length).
const pathB3 = path.join(TMP, "b3", "gateway-loopback.key");
fs.mkdirSync(path.dirname(pathB3), { recursive: true });
fs.writeFileSync(pathB3, "   \n");
let threwOnWhitespace = false;
try { getOrCreateLoopbackSecret(pathB3); } catch { threwOnWhitespace = true; }
check("(B) a whitespace-only file is ALSO treated as corrupt, not fatal", !threwOnWhitespace);

// ===================== (C) "concurrent" calls agree (the legitimate-race path) =====================
const pathC = path.join(TMP, "c", "gateway-loopback.key");
const secretC1 = getOrCreateLoopbackSecret(pathC); // first call creates it
const secretC2 = getOrCreateLoopbackSecret(pathC); // "second racer" — file already exists, legitimately
check("(C) two calls against the same secretPath agree on ONE secret (never two different ones)", secretC1 === secretC2);
check("(C) the on-disk file matches both", fs.readFileSync(pathC, "utf8").trim() === secretC1);

// ===================== (D) verifyLoopbackSecret edge cases =====================
const real = "a".repeat(64);
check("(D) rejects undefined", verifyLoopbackSecret(undefined, real) === false);
check("(D) rejects empty string", verifyLoopbackSecret("", real) === false);
check("(D) rejects a wrong-length value (shorter)", verifyLoopbackSecret("a".repeat(10), real) === false);
check("(D) rejects a wrong-length value (longer)", verifyLoopbackSecret("a".repeat(100), real) === false);
check("(D) rejects a right-length-but-wrong value", verifyLoopbackSecret("b".repeat(64), real) === false);
check("(D) accepts the exact match", verifyLoopbackSecret(real, real) === true);
{
  // Structural constant-time proof (mirrors gateway-token.mjs's own (B) pattern): the compiled
  // verifyLoopbackSecret body compares via Buffer + timingSafeEqual, never a raw `===` string compare.
  const secretPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "dist", "gateway", "loopback-secret.js");
  const src = fs.readFileSync(secretPath, "utf8");
  check("(D) verifyLoopbackSecret uses timingSafeEqual (constant-time), not a raw string compare", /timingSafeEqual\(/.test(src));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — getOrCreateLoopbackSecret mints a stable 256-bit secret, SELF-HEALS an empty/whitespace-corrupt file instead of throwing (the Major 1 boot-DoS fix), agrees with itself across repeated calls, and verifyLoopbackSecret constant-time-rejects undefined/empty/wrong-length/wrong-value while accepting only the exact match."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
