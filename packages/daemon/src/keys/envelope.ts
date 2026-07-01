import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SECRET_KEY_PATH } from "../paths.js";

/**
 * Recoverable-secret envelope — AES-256-GCM encrypt/decrypt for OUTWARD credentials the daemon must
 * DECRYPT to use (unlike `keys/hash.ts`, which is one-way salted SHA-256 for verify-only secrets).
 *
 * The canonical consumer is the Loom Companion bot token: the daemon needs the plaintext token to call
 * Telegram, but `loom.db` is BACKED UP (dbBackupWatcher) and can be synced across daemons — a plaintext
 * outward credential would leak into every backup. So the token is stored as ciphertext in the DB, and
 * the confidentiality guarantee rests on a SEPARATE local 32-byte key file (`SECRET_KEY_PATH`, under
 * LOOM_HOME) that is NEVER backed up: the ciphertext-in-backup is useless without it.
 *
 * Envelope format (one compact string, colon-joined — standard base64 never contains a colon):
 *   `v1:<iv b64>:<authTag b64>:<ciphertext b64>`
 * The `v1` version tag is the seam for a future algorithm migration (a `v2` decrypt path can branch on
 * it). GCM's auth tag makes tamper detection INHERENT: any modified iv/tag/ciphertext fails the tag
 * check and `decryptSecret` THROWS rather than returning garbage plaintext.
 *
 * Crypto discipline (load-bearing — do NOT regress): AES-256-GCM (authenticated; never CBC/ECB), a
 * FRESH random 96-bit iv PER encrypt (so the same plaintext yields distinct ciphertext and nonce reuse
 * can't leak the keystream), the auth tag ALWAYS verified on decrypt, and the key is NEVER logged.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // 96-bit nonce — the GCM-recommended iv size
const TAG_LEN = 16; // 128-bit GCM auth tag
const VERSION = "v1";

/**
 * Load the local master key, generating it LAZILY on first use with 0600 perms. Concurrent first-use is
 * race-safe: the create uses the `wx` (exclusive) flag, and a loser re-reads the winner's key. The key
 * is read fresh each call (no process cache) so a rotated key file is picked up and no key sits in a
 * long-lived module global. On win32 the 0600 mode is best-effort (documented in paths.ts).
 */
function loadOrCreateKey(keyPath: string): Buffer {
  const existing = readKeyIfPresent(keyPath);
  if (existing) return existing;
  const key = randomBytes(KEY_LEN);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  try {
    fs.writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readKeyIfPresent(keyPath); // another writer won the race — use its key
      if (raced) return raced;
    }
    throw err;
  }
  try {
    fs.chmodSync(keyPath, 0o600); // tighten perms even if a prior umask widened the create (best-effort on win32)
  } catch {
    /* win32 chmod is best-effort */
  }
  return key;
}

/** Read the key file if it exists; null if absent. Throws on a wrong-length (corrupt) key file. */
function readKeyIfPresent(keyPath: string): Buffer | null {
  let key: Buffer;
  try {
    key = fs.readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`envelope key at ${keyPath} has unexpected length ${key.length} (expected ${KEY_LEN})`);
  }
  return key;
}

/**
 * Encrypt a UTF-8 secret into a versioned `v1:iv:tag:ciphertext` envelope string. A fresh random iv is
 * drawn every call, so encrypting the same plaintext twice yields DIFFERENT blobs. `keyPath` overrides
 * the default local key file (the test seam — never touch the real ~/.loom in tests).
 */
export function encryptSecret(plaintext: string, keyPath: string = SECRET_KEY_PATH): string {
  const key = loadOrCreateKey(keyPath);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Decrypt a `v1:iv:tag:ciphertext` envelope back to the plaintext secret. Throws on a malformed blob,
 * an unknown version, or — crucially — a failed GCM auth tag (any tampering with iv/tag/ciphertext, or
 * a wrong key). `keyPath` mirrors `encryptSecret`.
 */
export function decryptSecret(blob: string, keyPath: string = SECRET_KEY_PATH): string {
  const parts = typeof blob === "string" ? blob.split(":") : [];
  const [ver, ivB64, tagB64, ctB64] = parts;
  if (parts.length !== 4 || ver !== VERSION || ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error(`unrecognized secret envelope (expected "${VERSION}:iv:tag:ciphertext")`);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("malformed secret envelope (bad iv/tag length)");
  }
  const key = loadOrCreateKey(keyPath);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag); // decipher.final() throws if this tag does not authenticate the ciphertext
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
