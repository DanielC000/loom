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
 * `ssh2`'s own key-parser error messages are mostly static strings, but a handful interpolate bytes
 * decoded straight from the SUBMITTED key text — e.g. a corrupt/truncated key fails with `Unsupported
 * OpenSSH key magic: ${magic}`, where `magic` is the first 15 raw decoded bytes of whatever was
 * submitted (`keyParser.js`'s `OpenSSH_Private.parse`). Echoing one of these verbatim into a REST 400
 * would leak a fragment of the submission (potentially real key bytes, for a near-valid/garbled key) to
 * whatever logs or displays that response. Every OTHER parse-failure message `ssh2` returns (malformed /
 * no-passphrase / bad-passphrase-integrity-check) is a fixed string with no interpolated content, so it's
 * safe to pass through unchanged — classify only the unsafe shapes away.
 */
const SSH2_ECHOES_SUBMISSION_BYTES_RE = /^Unsupported (OpenSSH (key magic|cipher for OpenSSH key|kdf name for OpenSSH key|private key type|OpenSSH public key type)|private key EC OID)/;
function classifySshParseError(message: string): string {
  return SSH2_ECHOES_SUBMISSION_BYTES_RE.test(message) ? "unrecognized or corrupt private key format" : message;
}

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
  const parsed = sshUtils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    // ssh2's own message distinguishes "encrypted, no passphrase given" from "bad passphrase" from
    // "unsupported key format" — but a handful of its messages interpolate raw submission bytes (see
    // classifySshParseError's own doc above), so route through it rather than echo parsed.message raw.
    return { ok: false, error: `invalid private key: ${classifySshParseError(parsed.message)}` };
  }

  let candidatePem = parsed.getPrivatePEM();
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
