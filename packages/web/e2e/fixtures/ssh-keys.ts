// Fixture ed25519 keys that are guaranteed to parse (card f4d013b6). Twin of the daemon tests' helper
// packages/daemon/test/_ssh-test-keys.mjs (generateParseableEd25519, card 28c304b2) — keep the two in step:
// same validity rule (ssh2 parseKey on the private half, with the passphrase) and same bounded retry count.
//
// WHY: ssh2 1.17.0's utils.generateKeyPairSync("ed25519") emits a malformed private key about 1 time in 256
// (its keygen strips a real leading 0x00 public-key byte together with the ASN.1 unused-bits byte). The
// daemon rightly refuses such a key ("Malformed OpenSSH private key"), which made the specs seeding one
// intermittently fail. Regenerate until parseKey accepts the result — bounded, never an infinite loop.
// ssh-malformed-ed25519.json is a captured bad pair for proving this helper's check can fail.

export const MAX_ED25519_GENERATION_ATTEMPTS = 20;

export interface Ed25519Pair { private: string; public: string }

/** `sshUtils` is ssh2's `utils`; `opts` is forwarded to generateKeyPairSync (e.g. { passphrase, cipher }). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function generateParseableEd25519(sshUtils: any, opts?: { passphrase?: string; cipher?: string }): Ed25519Pair {
  for (let attempt = 1; attempt <= MAX_ED25519_GENERATION_ATTEMPTS; attempt++) {
    const pair: Ed25519Pair = opts === undefined ? sshUtils.generateKeyPairSync("ed25519") : sshUtils.generateKeyPairSync("ed25519", opts);
    const parsed = sshUtils.parseKey(pair.private, opts?.passphrase);
    if (!(parsed instanceof Error)) return pair;
  }
  throw new Error(
    `ssh2 generator produced ${MAX_ED25519_GENERATION_ATTEMPTS} malformed ed25519 keys in a row ` +
      "(expected ~1 in 256 — see card 28c304b2); something other than the known keygen.js leading-zero defect is wrong",
  );
}
