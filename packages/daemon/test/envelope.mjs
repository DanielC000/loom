import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Recoverable-secret envelope helper (keys/envelope.ts) — AES-256-GCM encrypt/decrypt for OUTWARD
// credentials the daemon must DECRYPT to use (e.g. the companion bot token). Card 5ed5be7e.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: pure crypto over a temp key file; never touches the real ~/.loom.
//
// Covers the card's DoD exactly:
//   (A) round-trip: decryptSecret(encryptSecret(x)) === x for empty / unicode / long token-shaped inputs;
//   (B) tamper-detect: flipping a byte in ciphertext / iv / tag makes decrypt THROW (GCM auth tag);
//   (C) distinct ciphertext: encrypting the same plaintext twice yields DIFFERENT blobs, both decrypt back;
//   (D) key-file: created lazily on first use with 0600 (POSIX), REUSED on a second call (same key →
//       cross-call decrypt), and a key-path override seam so tests never touch the real ~/.loom;
//   (E) crypto shape: v1: version prefix, fresh iv per encrypt, plaintext never present in the blob,
//       and a WRONG key fails the auth tag (throws).
// Run: 1) build (turbo builds shared first), 2) node test/envelope.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const throws = (label, fn) => {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(label, threw);
};

// Hermetic LOOM_HOME so the DEFAULT key-path (SECRET_KEY_PATH, derived from LOOM_HOME in paths.ts) lands
// in a temp dir, never the real ~/.loom. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-envelope-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { encryptSecret, decryptSecret } = await import("../dist/keys/envelope.js");
const { SECRET_KEY_PATH } = await import("../dist/paths.js");

const isPosix = process.platform !== "win32";

// A dedicated per-test key path (the override seam) for most assertions; a separate one to prove default.
const keyPath = path.join(tmpHome, "keys", "test-secret.key");

try {
  // ===================== (A) round-trip for varied inputs =====================
  const inputs = [
    "",                                              // empty string
    "hello",                                         // ascii
    "🔒 unicode ✓ — café — 日本語",                   // unicode / multibyte
    "1234567890:abcdef:with:colons:and=base64/pad+", // separator + base64 chars in the PLAINTEXT
    "x".repeat(5000),                                // long
    randomTokenShaped(),                             // a bot-token-shaped string
  ];
  for (const x of inputs) {
    const blob = encryptSecret(x, keyPath);
    const back = decryptSecret(blob, keyPath);
    check(`(A) round-trip preserves input (${describe(x)})`, back === x);
  }

  // ===================== (B) tamper-detect (GCM auth tag) =====================
  const secret = "lrk-companion-bot-token-abc123";
  const blob = encryptSecret(secret, keyPath);
  const [ver, ivB64, tagB64, ctB64] = blob.split(":");
  check("(E) blob carries the v1 version prefix", ver === "v1");
  check("(E) blob has exactly 4 colon-joined parts", blob.split(":").length === 4);
  check("(E) the plaintext secret is NOT present in the blob (encrypted, not encoded)", !blob.includes(secret));

  throws("(B) flipping a ciphertext byte → decrypt THROWS", () => decryptSecret([ver, ivB64, tagB64, flipB64(ctB64)].join(":"), keyPath));
  throws("(B) flipping an iv byte → decrypt THROWS", () => decryptSecret([ver, flipB64(ivB64), tagB64, ctB64].join(":"), keyPath));
  throws("(B) flipping an auth-tag byte → decrypt THROWS", () => decryptSecret([ver, ivB64, flipB64(tagB64), ctB64].join(":"), keyPath));
  throws("(B) a truncated/garbage blob → decrypt THROWS", () => decryptSecret("v1:not-valid", keyPath));
  throws("(B) an unknown version → decrypt THROWS", () => decryptSecret(["v2", ivB64, tagB64, ctB64].join(":"), keyPath));
  // A tampered blob must NOT silently return the plaintext.
  let tamperedLeak = null;
  try { tamperedLeak = decryptSecret([ver, ivB64, tagB64, flipB64(ctB64)].join(":"), keyPath); } catch { /* expected */ }
  check("(B) a tampered blob never yields the plaintext", tamperedLeak !== secret);

  // ===================== (C) distinct ciphertext per encrypt (fresh iv) =====================
  const b1 = encryptSecret(secret, keyPath);
  const b2 = encryptSecret(secret, keyPath);
  check("(C) encrypting the same plaintext twice yields DIFFERENT blobs", b1 !== b2);
  check("(C) the two blobs use different ivs", b1.split(":")[1] !== b2.split(":")[1]);
  check("(C) both blobs decrypt back to the same plaintext", decryptSecret(b1, keyPath) === secret && decryptSecret(b2, keyPath) === secret);

  // ===================== (D) key file: lazy create + 0600 + reuse =====================
  check("(D) key file was created lazily on first use", fs.existsSync(keyPath));
  check("(D) key file is exactly 32 bytes (AES-256)", fs.statSync(keyPath).size === 32);
  if (isPosix) {
    const mode = fs.statSync(keyPath).mode & 0o777;
    check(`(D) key file is 0600 (got 0${mode.toString(8)})`, mode === 0o600);
  } else {
    console.log("SKIP  (D) 0600 perms assertion (win32 fs mode is best-effort)");
  }
  // REUSE: capture the key bytes, run more ops, confirm the file was not regenerated (same key → old blob still decrypts).
  const keyBytes = fs.readFileSync(keyPath);
  encryptSecret("another", keyPath);
  check("(D) key file is REUSED, not regenerated, across calls", Buffer.compare(keyBytes, fs.readFileSync(keyPath)) === 0);
  check("(D) a blob encrypted earlier still decrypts after further ops (stable key)", decryptSecret(blob, keyPath) === secret);

  // ===================== (D) default key path derives from LOOM_HOME (paths.ts), lands under temp =====================
  check("(D) SECRET_KEY_PATH resolves under the (temp) LOOM_HOME, not the real ~/.loom", SECRET_KEY_PATH.startsWith(tmpHome));
  const defBlob = encryptSecret("default-path-secret");        // no keyPath → uses SECRET_KEY_PATH
  check("(D) default-path encrypt lazily created SECRET_KEY_PATH", fs.existsSync(SECRET_KEY_PATH));
  check("(D) default-path round-trip works", decryptSecret(defBlob) === "default-path-secret");

  // ===================== (E) a WRONG key fails the auth tag (key isolation) =====================
  const otherKeyPath = path.join(tmpHome, "keys", "other-secret.key");
  const otherBlob = encryptSecret(secret, otherKeyPath); // a distinct key file → a distinct key
  check("(E) a second key path generated a DIFFERENT key file", Buffer.compare(fs.readFileSync(keyPath), fs.readFileSync(otherKeyPath)) !== 0);
  throws("(E) decrypting one key's blob under another key THROWS (auth-tag mismatch)", () => decryptSecret(otherBlob, keyPath));

  // ===================== (E) cross-INSTANCE decrypt: a fresh module import (same key file) decrypts =====================
  // Prove the key file — not an in-process global — is the root of trust: re-import the module and decrypt.
  const fresh = await import(`../dist/keys/envelope.js?reload=${Date.now()}`);
  check("(E) a freshly re-imported module decrypts a blob written by the first (key file is the root of trust)", fresh.decryptSecret(blob, keyPath) === secret);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}

function flipB64(b64) {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff; // flip every bit of the first byte
  return buf.toString("base64");
}
function randomTokenShaped() {
  // Deterministic-enough token shape (no Math.random needed): a Telegram-bot-token-like string.
  return "8123456789:AAH" + "Zx9-_QwErTy".repeat(3) + " k1";
}
function describe(x) {
  if (x === "") return "empty";
  return `len=${x.length}`;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — recoverable-secret envelope: AES-256-GCM round-trip (empty/unicode/long); GCM tamper-detect on iv/tag/ciphertext; distinct ciphertext per encrypt; lazy 0600 key file reused across calls; default path under LOOM_HOME; wrong-key auth-tag failure — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
