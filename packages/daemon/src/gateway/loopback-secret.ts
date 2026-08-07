import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LOOPBACK_SECRET_PATH } from "../paths.js";

/**
 * Card 9ccedbee — the loopback human-only-write guard secret. Mirrors `keys/envelope.ts`'s
 * `loadOrCreateKey` (same `wx`-exclusive lazy-create + best-effort 0600 chmod, same race-safe re-read
 * on EEXIST), but this is a plain bearer SECRET presented over the wire on every guarded request — not
 * an encryption key a decrypt path re-derives from stored ciphertext. Unlike the `gateway_tokens` store
 * (hashed at rest, plaintext shown once — right for a human-minted REMOTE credential the human copies
 * once into a client they control), THIS secret must stay recoverable in plaintext indefinitely: `loom
 * open`/`loom start` (bin/loom.mjs) re-reads it on every invocation to embed in the browser-open URL, and
 * a fresh browser tab that never saw that URL has no other way to obtain it. Hashing it at rest would
 * make that recovery impossible.
 *
 * Read fresh each call (no long-lived module cache) — mirrors envelope.ts's own reasoning: a rotated
 * (deleted + regenerated) file is picked up without a restart, and this only runs on the small subset of
 * `/api/*` write requests this guard actually covers, never a hot path.
 */
export function getOrCreateLoopbackSecret(secretPath: string = LOOPBACK_SECRET_PATH): string {
  const existing = readSecretIfPresent(secretPath);
  if (existing) return existing;
  const secret = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  try {
    fs.writeFileSync(secretPath, secret, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readSecretIfPresent(secretPath); // another writer won the race — use its secret
      if (raced) return raced;
      // The file EXISTS but is still unreadable-as-a-secret (empty, or some other corruption) — NOT a
      // legitimate race winner, since a real winner's write would have made `raced` non-null above. This
      // is the Code Review Major 1 fix: `getOrCreateLoopbackSecret` runs UNCONDITIONALLY on every daemon
      // boot (index.ts's `main()`), with nothing catching a throw here — before this fix, a trivially
      // creatable empty file (`: > ~/.loom/gateway-loopback.key`) made the daemon permanently unbootable
      // (an EEXIST throw out of main().catch is a non-75 exit, which STOPS daemon:stable's supervisor
      // loop until a human notices), i.e. a one-command persistent DoS this change itself introduced.
      // Regenerating (a plain overwrite, no `wx`) instead of throwing is safe specifically BECAUSE this
      // secret has no recoverability requirement across a corruption event — unlike envelope.ts's AES key
      // (which protects already-encrypted at-rest data a regenerate would orphan), invalidating this
      // secret just means any previously-captured browser token goes stale, requiring one re-visit to a
      // freshly-tokenized URL — an inconvenience, never a security regression.
      fs.writeFileSync(secretPath, secret, { mode: 0o600 });
      try {
        fs.chmodSync(secretPath, 0o600);
      } catch {
        /* win32 chmod is best-effort */
      }
      return secret;
    }
    throw err;
  }
  try {
    fs.chmodSync(secretPath, 0o600); // tighten perms even if a prior umask widened the create (best-effort on win32)
  } catch {
    /* win32 chmod is best-effort */
  }
  return secret;
}

/** Read the secret file if present; null if absent OR corrupt (e.g. empty) — `getOrCreateLoopbackSecret`
 *  treats either the same way: generate/regenerate. See that function's own comment for why regenerating
 *  a corrupt file (rather than throwing) is the deliberate, safe choice here. */
function readSecretIfPresent(secretPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(secretPath, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return raw.length > 0 ? raw : null;
}

/** Constant-time verify of a presented bearer secret against the real one — timing-safe and
 *  length-guarded (an empty/undefined presented value never compare-passes, even against a corrupt
 *  same-length-by-accident actual value, since `readSecretIfPresent` already rejects empty). */
export function verifyLoopbackSecret(presented: string | undefined, actual: string): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
