/**
 * SSH private-key handling for the `ssh` connection type (design record a3d5c7f4). Wraps `ssh2`'s pure-JS
 * key parser — the only reliable way to parse the `openssh-key-v1` format real `ssh-keygen` output uses by
 * default: Node's own `crypto.createPrivateKey` cannot read it at all, encrypted OR unencrypted (measured
 * in the design investigation). Used ONLY at connection-create time, to validate a submitted key and strip
 * its passphrase per the owner's decision (`docs/decisions/a3d5c7f4-ssh-connection-type.md`, decision 5) —
 * the exec core (card f6647205) re-parses the stored, already-passphrase-free key the same way at call time.
 */
import { randomBytes } from "node:crypto";
import ssh2 from "ssh2";
import type { ParsedKey } from "ssh2";

const { utils: sshUtils } = ssh2;

export type StripPassphraseResult =
  | { ok: true; privateKeyPem: string }
  | { ok: false; error: string };

function sshString(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
function sshUint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

// @decision a3d5c7f4 — never store ssh2's raw getPrivatePEM() output for an ed25519 key without
// re-verifying it via ssh2.utils.parseKey first, and never trust any storable form on a public-bytes
// compare alone — see the decision record's "self-verify" section for why.

/**
 * `ssh2`'s key-parser error messages are mostly static strings, but several interpolate bytes decoded
 * straight from the SUBMITTED key text (`Unsupported OpenSSH key magic: ${magic}`, `Unsupported cipher for
 * OpenSSH key: ${cipherName}`, `Cipher (${cipherName}) not supported ...` from a PEM DEK-Info header, ...).
 * Echoing one into a REST 400 would leak a fragment of the submission to whatever logs or displays the
 * response. So this is an ALLOWLIST, not a denylist: only these exact, fixed strings (each verified against
 * ssh2@1.17.0's `lib/protocol/keyParser.js`, line numbers below) are forwarded; ANY other message — including
 * a wording a future ssh2 adds — collapses to one generic fallback. Re-audit the list on an ssh2 bump.
 */
const SSH2_FIXED_PARSE_ERRORS: ReadonlySet<string> = new Set([
  "Malformed OpenSSH private key", // :475 etc.
  "Malformed OpenSSH private key. Bad passphrase?", // :887-889 (errMsg + ". Bad passphrase?")
  "Encrypted private OpenSSH key detected, but no passphrase given", // :495
  "Failed to generate information to decrypt key", // :533
  "OpenSSH key integrity check failed -- bad passphrase?", // :632
  "OpenSSH key integrity check failed", // :635
  "Malformed encrypted OpenSSH private key", // :845
  "Encrypted OpenSSH private key detected, but no passphrase given", // :847
  "Encrypted PPK private key detected, but no passphrase given", // :1046
  "PPK private key integrity check failed -- bad passphrase?", // :1112
  "PPK private key integrity check failed", // :1116
  "Malformed PPK private key", // :1134
  "Malformed PPK public key", // :1128
  "Malformed OpenSSH public key", // :1211
  "Malformed RFC4716 public key", // :1247
  "Unsupported key format", // :1476
]);
const GENERIC_PARSE_ERROR = "could not read this private key";
function classifySshParseError(message: string): string {
  return SSH2_FIXED_PARSE_ERRORS.has(message) ? message : GENERIC_PARSE_ERROR;
}

const PUBLIC_KEY_REFUSAL = "that is a public key; paste the PRIVATE key file";
const PEM_PUBLIC_KEY_ARMOR_RE = /-----BEGIN (?:RSA |EC |DSA )?PUBLIC KEY-----/;
const PEM_PRIVATE_KEY_ARMOR_RE = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const NO_STORABLE_FORM_REFUSAL = "could not produce a storable form of this key";

const ED25519_PKCS8_DER_LEN = 48; // RFC 8410 — fixed length for every Ed25519 PKCS8 PrivateKeyInfo, no optional fields.

/** Extract the raw 32-byte Ed25519 private seed from an unencrypted PKCS8 PEM (RFC 8410's fixed, 48-byte
 *  DER layout — the seed is always exactly the LAST 32 bytes). Throws if the DER doesn't match that
 *  exact, known-fixed shape, rather than silently slicing the wrong bytes. */
function extractEd25519SeedFromPkcs8Pem(pem: string): Buffer {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  if (der.length !== ED25519_PKCS8_DER_LEN) {
    throw new Error(`unexpected Ed25519 PKCS8 DER length ${der.length} (expected ${ED25519_PKCS8_DER_LEN})`);
  }
  return der.subarray(der.length - 32);
}

/** Build a minimal, UNENCRYPTED `openssh-key-v1` private-key container for a single Ed25519 key — see the
 *  decision note above for why this exists instead of reusing `getPrivatePEM()`'s output. */
function rebuildUnencryptedOpenSshEd25519(seed32: Buffer, pub32: Buffer, publicKeyBlob: Buffer): string {
  const cipherName = sshString(Buffer.from("none"));
  const kdfName = sshString(Buffer.from("none"));
  const kdfOptions = sshString(Buffer.alloc(0));
  const numKeys = sshUint32(1);
  const publicKeySection = sshString(publicKeyBlob);

  const checkint = randomBytes(4); // repeated verbatim — openssh's own decrypt-succeeded check; harmless for cipher "none".
  const privKeyType = sshString(Buffer.from("ssh-ed25519"));
  const pubField = sshString(pub32);
  const privField = sshString(Buffer.concat([seed32, pub32])); // openssh packs "seed||pub" as the ed25519 private field.
  const comment = sshString(Buffer.alloc(0));

  let inner = Buffer.concat([checkint, checkint, privKeyType, pubField, privField, comment]);
  const blockSize = 8; // cipher "none" still pads to an 8-byte boundary, per PROTOCOL.key.
  const padLen = (blockSize - (inner.length % blockSize)) % blockSize;
  inner = Buffer.concat([inner, Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1))]);

  const body = Buffer.concat([cipherName, kdfName, kdfOptions, numKeys, publicKeySection, sshString(inner)]);
  const full = Buffer.concat([Buffer.from("openssh-key-v1\0", "binary"), body]);
  const lines = (full.toString("base64").match(/.{1,70}/g) ?? []).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * Validate a submitted private key and return its PASSPHRASE-FREE, `ssh2`-re-parseable form (the ONLY
 * form ever handed to `encryptSecret` for storage — the original passphrase is used here, in memory, and
 * discarded). If the key is unencrypted, `passphrase` (if given) is simply ignored by `ssh2`'s own parser
 * — there's nothing to strip, and rejecting it would be friction with no security benefit. If the key IS
 * encrypted and no (or a wrong) passphrase is given, this FAILS — it never stores the still-encrypted
 * blob, which would defeat the "passphrase never stored" invariant by making every later daemon-side use
 * need it again.
 */
export function stripSshKeyPassphrase(privateKey: unknown, passphrase: unknown): StripPassphraseResult {
  if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
    return { ok: false, error: "privateKey must be a non-empty string" };
  }
  if (passphrase !== undefined && typeof passphrase !== "string") {
    return { ok: false, error: "passphrase, when given, must be a string" };
  }
  // PEM public-key armor (SPKI / PKCS#1) is not parsed by ssh2 at all ("Unsupported key format"), so name it here.
  // A private-key armor anywhere wins (a valid private key with a public block appended is still a private key).
  if (!PEM_PRIVATE_KEY_ARMOR_RE.test(privateKey) && PEM_PUBLIC_KEY_ARMOR_RE.test(privateKey)) return { ok: false, error: PUBLIC_KEY_REFUSAL };
  const parsed = sshUtils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    // ssh2's own message distinguishes "encrypted, no passphrase given" from "bad passphrase" from
    // "unsupported key format" — but a handful of its messages interpolate raw submission bytes (see
    // classifySshParseError's own doc above), so route through it rather than echo parsed.message raw.
    return { ok: false, error: `invalid private key: ${classifySshParseError(parsed.message)}` };
  }

  // A PUBLIC key parses fine (parseKey returns a ParsedKey) but has no private half: getPrivatePEM() returns
  // null for it. Refuse with FIXED text, never echo the submission (card c4e959be).
  if (!parsed.isPrivateKey()) return { ok: false, error: PUBLIC_KEY_REFUSAL };
  let candidatePem: string | null;
  try {
    candidatePem = parsed.getPrivatePEM();
  } catch {
    return { ok: false, error: NO_STORABLE_FORM_REFUSAL };
  }
  if (typeof candidatePem !== "string" || candidatePem.length === 0) return { ok: false, error: NO_STORABLE_FORM_REFUSAL };
  try {
    return finishStrip(parsed, candidatePem);
  } catch {
    // Fail closed on any unexpected ssh2/derivation throw; the thrown message is never forwarded (it can
    // carry submission-derived text).
    return { ok: false, error: NO_STORABLE_FORM_REFUSAL };
  }
}

function finishStrip(parsed: ParsedKey, candidatePem: string): StripPassphraseResult {
  if (sshUtils.parseKey(candidatePem) instanceof Error) {
    if (parsed.type !== "ssh-ed25519") {
      return { ok: false, error: `could not produce a storable form of this ${parsed.type} key` };
    }
    const seed = extractEd25519SeedFromPkcs8Pem(candidatePem);
    const publicKeyBlob = parsed.getPublicSSH();
    const pub32 = publicKeyBlob.subarray(publicKeyBlob.length - 32);
    candidatePem = rebuildUnencryptedOpenSshEd25519(seed, pub32, publicKeyBlob);
  }
  const reparsed = sshUtils.parseKey(candidatePem);
  if (reparsed instanceof Error) {
    return { ok: false, error: "failed to produce a re-parseable storable form of this key" };
  }
  const verifyError = selfVerifyKeyMaterial(parsed, reparsed);
  if (verifyError) return { ok: false, error: verifyError };
  return { ok: true, privateKeyPem: candidatePem };
}

/**
 * Prove `candidate`'s own private material genuinely corresponds to `original`'s public half, by
 * signing a random nonce with `candidate` and verifying it against `original` — see the decision
 * record's "self-verify" section for why a `getPublicSSH()`-bytes compare alone is not enough. Returns
 * an error string on any failure, or null when the two keys are proven to be the same key.
 */
function selfVerifyKeyMaterial(original: ParsedKey, candidate: ParsedKey): string | null {
  const nonce = randomBytes(32);
  const signature = candidate.sign(nonce);
  if (signature instanceof Error) {
    return `failed to self-verify this key (sign failed: ${signature.message})`;
  }
  // @types/ssh2 types verify() as always returning `boolean`, but the real runtime (ssh2's own
  // keyParser.js BaseKey.verify) can return an Error — cast to the true runtime contract before narrowing.
  const verified = original.verify(nonce, signature) as boolean | Error;
  if (verified instanceof Error) {
    return `failed to self-verify this key (verify failed: ${verified.message})`;
  }
  if (verified !== true) {
    return "failed to self-verify this key (signature did not verify against the original key)";
  }
  return null;
}
