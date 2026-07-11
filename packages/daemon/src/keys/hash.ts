import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Agent Runs R1 — API-key secret minting + verification (the "hashed at rest, plaintext once" core).
 *
 * The daemon had NO pre-existing key-hashing util (only a content-addressing `createHash` for worktree
 * dirnames), so per the task this is a standard salted SHA-256. API keys are HIGH-ENTROPY (256-bit
 * random) secrets, not human passwords — a salted single-round SHA-256 is the right tool (a slow
 * password KDF buys nothing against a 256-bit random secret); the per-key salt still defeats any
 * cross-key precomputation and keeps two keys with the (astronomically unlikely) same secret distinct.
 *
 * Token format: `lrk_<keyId>.<secret>` ("loom run key"). The keyId is the PUBLIC db row id (not a
 * secret) so verification is an O(1) lookup-then-constant-time-compare rather than scanning every row;
 * the `<secret>` after the `.` is the only secret part. `.` is the separator because it appears in
 * neither a uuid (hex + `-`) nor base64url (`A–Za–z0–9-_`), so parsing is unambiguous.
 */

const TOKEN_PREFIX = "lrk_";
/** Companion DM-pairing codes reuse the SAME salted-hash core (hashed at rest, plaintext once) but carry
 *  a DISTINCT, human-recognizable prefix so an inbound chat message is only treated as a redemption
 *  candidate when it is plausibly-a-code — every other message falls straight through to the normal
 *  reject, never even touching the pairing store. Format: `pair_<codeId>.<secret>`. */
const PAIRING_PREFIX = "pair_";

export interface MintedKey {
  /** The db row id (public; embedded in the token for O(1) verify lookup). */
  id: string;
  /** The full plaintext token — returned to the human ONCE, never stored. */
  plaintext: string;
  /** Per-key random salt (hex) stored at rest. */
  salt: string;
  /** Salted SHA-256 of the secret (hex) stored at rest — never the plaintext. */
  hash: string;
}

/** Salted SHA-256 of a secret (hex). Salt is mixed in with a separator so salt/secret can't realign. */
function hashSecret(secret: string, salt: string): string {
  return createHash("sha256").update(salt).update(".").update(secret).digest("hex");
}

/**
 * Mint a fresh API key: a new id (or a supplied one — rotation reuses the existing row id so the
 * old secret stops verifying while the key identity is preserved) + a 256-bit random secret, returning
 * the one-time plaintext token alongside the salt+hash to persist.
 */
export function mintApiKey(id: string = randomUUID()): MintedKey {
  const secret = randomBytes(32).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  return { id, plaintext: `${TOKEN_PREFIX}${id}.${secret}`, salt, hash: hashSecret(secret, salt) };
}

/** Parse a `<prefix><id>.<secret>` token into its public id + secret parts; null if malformed. */
function parsePrefixedToken(token: unknown, prefix: string): { id: string; secret: string } | null {
  if (typeof token !== "string" || !token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) return null; // need a non-empty id AND secret
  return { id: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

/** Parse a presented token into its public id + secret parts; null if malformed (not our format). */
export function parseApiKey(token: unknown): { id: string; secret: string } | null {
  return parsePrefixedToken(token, TOKEN_PREFIX);
}

/**
 * Mint a fresh Companion DM-pairing code — the SAME salted-hash core as mintApiKey (the stored salt+hash
 * verify a redeemed code without ever persisting plaintext), only with the `pair_` prefix. The salt+hash
 * are computed over the SECRET alone, so the prefix swap is verification-transparent.
 */
export function mintPairingCode(id: string = randomUUID()): MintedKey {
  const k = mintApiKey(id);
  return { ...k, plaintext: `${PAIRING_PREFIX}${k.plaintext.slice(TOKEN_PREFIX.length)}` };
}

/** Parse a presented pairing code into its public id + secret parts; null if not `pair_`-shaped. */
export function parsePairingCode(token: unknown): { id: string; secret: string } | null {
  return parsePrefixedToken(token, PAIRING_PREFIX);
}

/** Access-story gateway tokens (Phase B, card 56ffe50a) reuse the SAME salted-hash core, with a
 *  DISTINCT `lgw_` ("loom gateway") prefix — the prefix IS the scope check: a Run key (`lrk_`) can
 *  never parse (and thus never verify) as a gateway token, and a gateway token can never parse as a
 *  Run key, so the two credential kinds can't authorize each other's surface even by accident. */
const GATEWAY_PREFIX = "lgw_";

/** Mint a fresh gateway token — same shape as `mintApiKey`, only with the `lgw_` prefix. */
export function mintGatewayToken(id: string = randomUUID()): MintedKey {
  const k = mintApiKey(id);
  return { ...k, plaintext: `${GATEWAY_PREFIX}${k.plaintext.slice(TOKEN_PREFIX.length)}` };
}

/** Parse a presented token into its public id + secret parts; null if not `lgw_`-shaped. */
export function parseGatewayToken(token: unknown): { id: string; secret: string } | null {
  return parsePrefixedToken(token, GATEWAY_PREFIX);
}

/** Constant-time verify of a presented secret against a stored salt+hash (timing-safe; length-guarded). */
export function verifySecret(secret: string, salt: string, hash: string): boolean {
  const a = Buffer.from(hashSecret(secret, salt), "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
