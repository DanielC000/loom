// Shared test helper (underscore-prefixed: not a test itself) — fixture ed25519 keys that are guaranteed to
// parse. Card 28c304b2.
//
// WHY: ssh2 1.17.0's `utils.generateKeyPairSync("ed25519")` (lib/keygen.js, ed25519 case) runs a "remove
// leading zero bytes" loop over the SPKI BitString content. That content begins with the ASN.1 unused-bits
// byte 0x00, so the loop is only correct when the real public key's first byte is non-zero. When it IS zero
// (1 key in 256), the loop strips the real key's leading 0x00 together with the unused-bits byte and ssh2
// serialises a 31-byte public key / 63-byte private field. The resulting container is malformed: ssh2's own
// `parseKey` rejects it ("Malformed OpenSSH private key") and so does OpenSSH (`ssh-keygen -y`: "error in
// libcrypto"). Measured 48 of 10,000 keys, every one with exactly that 31/63-byte signature. The product
// (`stripSshKeyPassphrase`) fails closed on such a key, so this is a fixture-generation flake only.
//
// FIX: retry generation until `parseKey` accepts the result — bounded, never an infinite loop.

export const MAX_ED25519_GENERATION_ATTEMPTS = 20;

/**
 * @param {{ generateKeyPairSync: Function, parseKey: Function }} sshUtils ssh2's `utils`
 * @param {object} [opts] forwarded to generateKeyPairSync (e.g. { passphrase, cipher })
 */
export function generateParseableEd25519(sshUtils, opts) {
  for (let attempt = 1; attempt <= MAX_ED25519_GENERATION_ATTEMPTS; attempt++) {
    const pair = opts === undefined ? sshUtils.generateKeyPairSync("ed25519") : sshUtils.generateKeyPairSync("ed25519", opts);
    const parsed = sshUtils.parseKey(pair.private, opts && opts.passphrase);
    if (!(parsed instanceof Error)) return pair;
  }
  throw new Error(
    `ssh2 generator produced ${MAX_ED25519_GENERATION_ATTEMPTS} malformed ed25519 keys in a row ` +
      "(expected ~1 in 256 — see card 28c304b2); something other than the known keygen.js leading-zero defect is wrong",
  );
}
