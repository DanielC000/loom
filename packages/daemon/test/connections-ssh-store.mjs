import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// SSH connection type (design record a3d5c7f4, card f9972a3d). SECURITY-CRITICAL, fully hermetic: a REAL
// Db on a temp LOOM_HOME + the REAL envelope key file + the REAL buildServer (app.inject) + the REAL MCP
// routers (setup/orchestration/platform/core-tasks) instantiated in-process. NO live network, NO real
// claude, NO daemon, NO external `ssh-keygen` binary — fixture keys are generated in pure JS via ssh2's
// own `utils.generateKeyPairSync`.
//
// Covers the card's DoD:
//   1. round-trip encrypt/decrypt + same-key proof.
//   2. validation-rejection: bad port/user/fingerprint/oversize/truncated key, encrypted key with no (or
//      a wrong) passphrase — none of these write a row, and none echoes submitted key bytes into its error.
//   3. passphrase handling (owner decision 5): used once in memory, never stored in any form.
//   4. agent-facing reads/projections never expose the key (never-echo) — see `deriveKeyMarkers`' own doc
//      for why the markers are derived from the SECRET seed, never the stored container's header.
//   5. human-only REST create/update, never an agent MCP path (core-tasks included).
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-ssh-store.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connections-ssh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  createConnection, createSshConnection, getConnectionMetadata, listConnections, deleteConnection,
  getSshPrivateKeyForUse, getSecretForUse, resolveScopedConnectionSecret, resolveUsableConnections,
  updateSshConnectionConfig, validateSshConnectionInput, CONNECTION_SECRET_MAX,
} = await import("../dist/connections/store.js");
const { decryptSecret } = await import("../dist/keys/envelope.js");
const { performAuthenticatedRequest } = await import("../dist/connections/request.js");
const { computeHostKeyFingerprint } = await import("../dist/connections/ssh.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const sshDefault = (await import("ssh2")).default;
const { utils: sshUtils } = sshDefault;
const { DEFAULT_SSH_RISKY_COMMAND_PATTERNS } = await import("@loom/shared");

const dbFile = (name) => path.join(tmpHome, name);

// --- Fixture keys — pure-JS generated, no `ssh-keygen` binary needed. ---------------------------------
const PASSPHRASE = "correct-horse-battery-staple";
// ssh2 1.17.0's ed25519 generator emits a malformed key 1 time in 256 (card 28c304b2) — see _ssh-test-keys.mjs.
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");
const unenc = generateParseableEd25519(sshUtils);
const enc = generateParseableEd25519(sshUtils, { passphrase: PASSPHRASE, cipher: "aes256-ctr" });
// A real, format-valid host-key fingerprint — doesn't need to correspond to any real server for this
// card's scope (the connect-time compare belongs to the exec core, card f6647205); format validity is
// what this layer checks.
const FINGERPRINT = "SHA256:" + "A".repeat(43);

const unencPub = sshUtils.parseKey(unenc.private).getPublicSSH();

/**
 * Extract the raw 32-byte Ed25519 private SEED from a decrypted/stored key, via the SAME fixed RFC 8410
 * PKCS8 layout `sshKey.ts`'s own `extractEd25519SeedFromPkcs8Pem` relies on — re-derived independently
 * here through `getPrivatePEM()` rather than by re-implementing the openssh-key-v1 container's byte
 * layout by hand, so this can't silently drift from what the production parser actually does.
 */
function extractEd25519Seed(decryptedPem) {
  const parsed = sshUtils.parseKey(decryptedPem);
  if (parsed instanceof Error) throw new Error(`cannot parse decrypted key: ${parsed.message}`);
  const pkcs8Pem = parsed.getPrivatePEM(); // always re-EXPORTABLE for ed25519, even where parseKey can't re-IMPORT it (sshKey.ts)
  const der = Buffer.from(pkcs8Pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  if (der.length !== 48) throw new Error(`unexpected Ed25519 PKCS8 DER length ${der.length}`);
  return { seed: der.subarray(der.length - 32), pkcs8Pem }; // RFC 8410's fixed layout — seed is always the LAST 32 bytes
}

/**
 * @decision f9972a3d — never derive a never-echo marker from a stored container's fixed header bytes;
 * always derive from the actual secret material, verified to discriminate between independently
 * generated keys of the same type.
 */
function deriveKeyMarkers(decryptedPem) {
  const { seed } = extractEd25519Seed(decryptedPem);
  const body = decryptedPem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
  const PRIVATE_SECTION_CHAR_OFFSET = 212;
  if (body.length < PRIVATE_SECTION_CHAR_OFFSET + 32) throw new Error("decrypted key body too short to slice a private-section marker from");
  const privateSectionBase64 = body.slice(PRIVATE_SECTION_CHAR_OFFSET, PRIVATE_SECTION_CHAR_OFFSET + 32);
  // Self-check (not just asserted elsewhere): offset 212 is base64-group-aligned (212 = 53*4), so decoding
  // a 32-char/24-byte slice from there must reproduce container bytes [159:183] — overlapping the seed
  // (which starts at byte 161) at [161:183] = seed[0:22]. If this doesn't hold, the offset math above is
  // wrong and privateSectionBase64 is NOT actually inside the seed — fail loudly rather than ship a marker
  // that silently isn't a marker.
  const decodedPrivateSection = Buffer.from(privateSectionBase64, "base64");
  if (!decodedPrivateSection.subarray(2).equals(seed.subarray(0, 22))) {
    throw new Error("privateSectionBase64 offset math is wrong — it does not overlap the extracted seed");
  }
  return {
    base64Seed: seed.toString("base64"),
    hexSeed: seed.toString("hex"),
    bufferDecimals: JSON.stringify(Array.from(seed.subarray(0, 8))),
    privateSectionBase64,
  };
}

/** True if ANY of `markers`' four forms appears as a literal substring of `text`. */
function anyMarkerIn(markers, text) {
  return Object.values(markers).some((m) => text.includes(m));
}

/**
 * Positive control: proves the plain-string-search mechanism used below actually FINDS a marker when
 * it's embedded in a JSON shape resembling a real leak, before trusting that same search's silence
 * anywhere agent-visible.
 */
function detectionMechanismWorks(marker, haystackObj) {
  return JSON.stringify(haystackObj).includes(marker);
}

try {
  // ============ Part 1 — round-trip, at-rest encryption, validation-rejection (direct store calls) =====
  {
    const db = new Db(dbFile("p1.db"));

    // --- validateSshConnectionInput: bad port / bad user / bad fingerprint, standalone ---
    const baseValid = { name: "n", host: "h.example", user: "deploy", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT };
    check("validate: a fully valid input passes", validateSshConnectionInput(baseValid).ok === true);
    check("validate: port 0 rejected", validateSshConnectionInput({ ...baseValid, port: 0 }).ok === false);
    check("validate: port 65536 rejected", validateSshConnectionInput({ ...baseValid, port: 65536 }).ok === false);
    check("validate: non-integer port rejected", validateSshConnectionInput({ ...baseValid, port: 22.5 }).ok === false);
    check("validate: string port rejected", validateSshConnectionInput({ ...baseValid, port: "22" }).ok === false);
    check("validate: omitted port defaults to 22", validateSshConnectionInput(baseValid).port === 22);
    check("validate: blank user rejected", validateSshConnectionInput({ ...baseValid, user: "" }).ok === false);
    check("validate: oversized user rejected", validateSshConnectionInput({ ...baseValid, user: "x".repeat(257) }).ok === false);
    check("validate: missing fingerprint rejected", validateSshConnectionInput({ ...baseValid, hostKeyFingerprint: undefined }).ok === false);
    check("validate: fingerprint without SHA256: prefix rejected", validateSshConnectionInput({ ...baseValid, hostKeyFingerprint: "A".repeat(43) }).ok === false);
    check("validate: fingerprint with wrong length rejected", validateSshConnectionInput({ ...baseValid, hostKeyFingerprint: "SHA256:" + "A".repeat(42) }).ok === false);
    check("validate: fingerprint with an invalid char rejected", validateSshConnectionInput({ ...baseValid, hostKeyFingerprint: "SHA256:" + "A".repeat(42) + "!" }).ok === false);
    check("validate: oversized privateKey rejected", validateSshConnectionInput({ ...baseValid, privateKey: "x".repeat(CONNECTION_SECRET_MAX + 1) }).ok === false);
    check("validate: omitted riskyCommandPatterns defaults to the shipped list", JSON.stringify(validateSshConnectionInput(baseValid).riskyCommandPatterns) === JSON.stringify(DEFAULT_SSH_RISKY_COMMAND_PATTERNS));
    check("validate: omitted commandAllowlist defaults to empty", validateSshConnectionInput(baseValid).commandAllowlist.length === 0);
    check("validate: readOnly defaults to true", validateSshConnectionInput(baseValid).readOnly === true);
    check("validate: shellSyntax defaults to false", validateSshConnectionInput(baseValid).shellSyntax === false);
    check("validate: shellSyntax:true with the default readOnly is rejected (read-write only)", validateSshConnectionInput({ ...baseValid, shellSyntax: true }).ok === false);
    check("validate: shellSyntax:true with readOnly:false accepted", validateSshConnectionInput({ ...baseValid, readOnly: false, shellSyntax: true }).shellSyntax === true);
    check("validate: a non-boolean shellSyntax rejected", validateSshConnectionInput({ ...baseValid, readOnly: false, shellSyntax: "yes" }).ok === false);
    check("validate: a bad command-rule kind rejected", validateSshConnectionInput({ ...baseValid, commandAllowlist: [{ kind: "nope", pattern: "x" }] }).ok === false);
    check("validate: an empty-pattern command rule rejected", validateSshConnectionInput({ ...baseValid, commandAllowlist: [{ kind: "exact", pattern: "" }] }).ok === false);
    check("validate: an invalid regex command rule rejected", validateSshConnectionInput({ ...baseValid, commandAllowlist: [{ kind: "regex", pattern: "(unclosed" }] }).ok === false);
    check("validate: a valid regex command rule accepted", validateSshConnectionInput({ ...baseValid, commandAllowlist: [{ kind: "regex", pattern: "^ls\\b" }] }).ok === true);
    check("validate: too many command rules rejected", validateSshConnectionInput({ ...baseValid, commandAllowlist: Array.from({ length: 101 }, () => ({ kind: "exact", pattern: "x" })) }).ok === false);

    // --- createSshConnection: round-trip, metadata shape, at-rest encryption ---
    const countBefore = db.listConnections().length;
    const created = createSshConnection(db, {
      name: "Homelab NAS", host: "10.0.0.5", port: 2222, user: "loom",
      privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT,
      commandAllowlist: [{ kind: "prefix", pattern: "ls " }],
    });
    check("create: returns metadata with an id", typeof created.id === "string" && created.id.length > 0);
    check("create: authScheme is 'ssh'", created.authScheme === "ssh");
    check("create: port/user/host/fingerprint carried", created.port === 2222 && created.user === "loom" && created.host === "10.0.0.5" && created.hostKeyFingerprint === FINGERPRINT);
    check("create: readOnly defaults true", created.readOnly === true);
    check("create: commandAllowlist carried", JSON.stringify(created.commandAllowlist) === JSON.stringify([{ kind: "prefix", pattern: "ls " }]));
    check("create: riskyCommandPatterns defaulted to the shipped list", JSON.stringify(created.riskyCommandPatterns) === JSON.stringify(DEFAULT_SSH_RISKY_COMMAND_PATTERNS));
    check("create: returned metadata has NO privateKey/secret/secretBlob/passphrase key", !("privateKey" in created) && !("secret" in created) && !("secretBlob" in created) && !("passphrase" in created));

    const row = db.getConnection(created.id);
    check("at-rest: stored blob is NOT the raw key text", row.secretBlob !== unenc.private);
    check("at-rest: stored blob is a v1 envelope", row.secretBlob.startsWith("v1:"));
    check("at-rest: row has no plaintext privateKey/passphrase column at all", !("privateKey" in row) && !("passphrase" in row));

    const decrypted = getSshPrivateKeyForUse(db, created.id);
    check("decrypt: getSshPrivateKeyForUse returns the EXACT envelope-decrypted plaintext", decrypted === decryptSecret(row.secretBlob));
    check("decrypt: the decrypted key is a valid, parseable (unencrypted) key", !(sshUtils.parseKey(decrypted) instanceof Error));
    const decryptedPub = sshUtils.parseKey(decrypted).getPublicSSH();
    check("decrypt: the stored key is the SAME key (same public-key bytes) as submitted", Buffer.compare(decryptedPub, unencPub) === 0);
    check("decrypt: getSshPrivateKeyForUse: unknown id -> undefined (never throws)", getSshPrivateKeyForUse(db, "nope") === undefined);

    // The PLANTED KEY MARKERS for THIS connection — derived from its own REAL decrypted/stored SECRET
    // material, not from a header and not from the submitted text (see deriveKeyMarkers' own doc).
    const KEY_MARKERS = deriveKeyMarkers(decrypted);
    // base64Seed is re-encoded from the ISOLATED 32-byte seed, so it is NOT a literal substring of the
    // container's own base64 text unless the seed happens to start at a 3-byte-aligned offset (it
    // doesn't here) — that's exactly why privateSectionBase64 exists (a literal slice of the container's
    // ACTUAL base64 text, at a known-aligned offset). base64Seed is still a genuine marker for the
    // "re-serialized elsewhere" leak shapes the positive controls below cover.
    check("(positive control) privateSectionBase64 marker is present in the connection's own decrypted/stored key", decrypted.includes(KEY_MARKERS.privateSectionBase64));

    // --- positive controls: each marker FORM is proven to actually detect its own matching leak SHAPE,
    // before trusting that same search's silence anywhere agent-visible below. ---
    check("(positive control) a base64-of-the-secret leak is detected", detectionMechanismWorks(KEY_MARKERS.base64Seed, { id: "probe", keyMaterial: extractEd25519Seed(decrypted).seed.toString("base64") }));
    check("(positive control) a HEX-of-the-secret leak is detected", detectionMechanismWorks(KEY_MARKERS.hexSeed, { id: "probe", keyHex: extractEd25519Seed(decrypted).seed.toString("hex") }));
    // The PKCS8 PEM's base64 text is a DIFFERENT container, with a different byte alignment, than the
    // openssh-key-v1 PEM our other markers are sliced from — hexSeed (byte-positional, no alignment
    // concerns) is the form that can prove a leak of it either way (a raw PEM dump, or a hex dump of its
    // DER) would be caught.
    const pkcs8Der = Buffer.from(extractEd25519Seed(decrypted).pkcs8Pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
    check("(positive control) a PKCS8 getPrivatePEM()-form leak (hex-dumped) is detected", detectionMechanismWorks(KEY_MARKERS.hexSeed, { id: "probe", pkcs8Hex: pkcs8Der.toString("hex") }));
    check("(positive control) a Buffer-shaped (never-stringified) leak is detected", detectionMechanismWorks(KEY_MARKERS.bufferDecimals, { id: "probe", debug: extractEd25519Seed(decrypted).seed.subarray(0, 8) }));
    check("(positive control) a header-stripped PEM slice (the reviewer's own `.slice(80)` mutant shape) is detected", detectionMechanismWorks(KEY_MARKERS.privateSectionBase64, { id: "probe", debug: decrypted.slice(80) }));

    check("create: returned metadata JSON does not contain ANY key marker", !anyMarkerIn(KEY_MARKERS, JSON.stringify(created)));
    check("at-rest: stored blob does NOT contain ANY key marker", !anyMarkerIn(KEY_MARKERS, row.secretBlob));

    // --- cross-key isolation control (round 3, item 1): a marker derived from THIS key must never appear
    // in a GENUINELY DIFFERENT key's own stored/decrypted form — proves the markers are tied to the real
    // SOURCE KEY's secret material, not to the per-connection random checkint (two connections sharing
    // the SAME source key legitimately share the SAME seed-derived markers — that's expected, not a bug;
    // this control uses a wholly independent key to isolate real cross-contamination from that). ---
    const otherKeyConn = createSshConnection(db, { name: "Unrelated Key", host: "10.0.0.99", user: "loom", privateKey: generateParseableEd25519(sshUtils).private, hostKeyFingerprint: FINGERPRINT });
    const otherDecrypted = getSshPrivateKeyForUse(db, otherKeyConn.id);
    check("(cross-key control) this connection's markers are absent from an UNRELATED key's own decrypted/stored key", !anyMarkerIn(KEY_MARKERS, otherDecrypted));
    deleteConnection(db, otherKeyConn.id);

    // --- fail-closed: getSecretForUse (the generic HTTPS-dispatch / P4 static-injection seam) NEVER
    // resolves an ssh row's secret (mirrors the pre-existing oauth2 exclusion) ---
    check("fail-closed: getSecretForUse(ssh id) -> undefined (never the key)", getSecretForUse(db, created.id) === undefined);
    check("fail-closed: resolveScopedConnectionSecret(ssh id) -> undefined", resolveScopedConnectionSecret(db, created.id) === undefined);

    // --- fail-closed: resolveUsableConnections (authenticated_request's own usable-connections list)
    // never advertises an `ssh` connection — advertising one it can only ever refuse is the "connection
    // not found" confusion this fix round's item 5 closes. ---
    check("fail-closed: resolveUsableConnections never lists an ssh connection", !resolveUsableConnections(db, [created.id], null).some((c) => c.id === created.id));

    // --- metadata reads never carry the key ---
    const list = listConnections(db);
    const listJson = JSON.stringify(list);
    check("list: includes the ssh row", list.some((c) => c.id === created.id));
    check("list: JSON does not contain ANY key marker", !anyMarkerIn(KEY_MARKERS, listJson));
    check("list: JSON has no secretBlob/privateKey key", !listJson.includes("secretBlob") && !listJson.includes("privateKey"));
    const got = getConnectionMetadata(db, created.id);
    check("get: metadata round-trips", got && got.id === created.id && got.authScheme === "ssh");

    // --- passphrase handling: a passphrase-protected key is stripped and never stored ---
    const createdEnc = createSshConnection(db, {
      name: "Homelab Pi", host: "10.0.0.6", user: "loom",
      privateKey: enc.private, passphrase: PASSPHRASE, hostKeyFingerprint: FINGERPRINT,
    });
    const decryptedEnc = getSshPrivateKeyForUse(db, createdEnc.id);
    check("passphrase: the stored key decrypts WITHOUT needing the passphrase (already stripped)", !(sshUtils.parseKey(decryptedEnc) instanceof Error));
    check("passphrase: the stored (stripped) key is the SAME key as the original encrypted one", Buffer.compare(sshUtils.parseKey(decryptedEnc).getPublicSSH(), sshUtils.parseKey(enc.private, PASSPHRASE).getPublicSSH()) === 0);
    check("passphrase: the PASSPHRASE STRING ITSELF never appears in the stored row", !JSON.stringify(db.getConnection(createdEnc.id)).includes(PASSPHRASE));
    check("passphrase: the passphrase string never appears in the returned metadata", !JSON.stringify(createdEnc).includes(PASSPHRASE));

    // The ENC connection's OWN key markers — derived from ITS OWN decrypted/stored key. `enc` was
    // generated as a wholly SEPARATE keypair from `unenc` above (two independent
    // `generateKeyPairSync` calls), so these markers legitimately differ from `created`'s — NOT because
    // of the per-connection random checkint (which has no bearing on the seed-derived markers at all;
    // two connections sharing the SAME source key would correctly share the SAME markers, which is
    // expected, not a bug — see the cross-key isolation control above, which is what actually proves
    // isolation using a genuinely different key).
    const encRow = db.getConnection(createdEnc.id);
    const ENC_KEY_MARKERS = deriveKeyMarkers(decryptedEnc);
    check("(positive control) enc-connection's privateSectionBase64 marker is present in ITS OWN decrypted/stored key", decryptedEnc.includes(ENC_KEY_MARKERS.privateSectionBase64));
    check("passphrase: returned metadata JSON does not contain ANY of the enc connection's key markers", !anyMarkerIn(ENC_KEY_MARKERS, JSON.stringify(createdEnc)));
    check("passphrase: stored blob does NOT contain ANY of the enc connection's key markers", !anyMarkerIn(ENC_KEY_MARKERS, encRow.secretBlob));

    // --- validation-rejection: encrypted key with no / wrong passphrase never writes a row ---
    const countBeforeRejects = db.listConnections().length;
    const throwsFor = (label, input) => {
      let threw = false; let msg = "";
      try { createSshConnection(db, input); } catch (e) { threw = true; msg = e.message; }
      check(`reject: ${label} -> throws`, threw);
      return msg;
    };
    // A marker for the RAW SUBMITTED (still-encrypted) key text — distinct from the stored-key markers
    // above. A rejected "no/wrong passphrase" create never decrypts or stores anything (parseKey fails
    // before either happens), so the real risk here is the submitted text itself echoing into the error —
    // this is the one place a marker derived from the submission (not the stored form) is the right check.
    const SUBMITTED_KEY_MARKER = enc.private.split("\n")[2].slice(0, 40);
    check("(positive control) submitted-key marker is present in the raw submitted (still-encrypted) key text", enc.private.includes(SUBMITTED_KEY_MARKER));
    const noPassMsg = throwsFor("encrypted key, no passphrase given", { name: "x", host: "h", user: "u", privateKey: enc.private, hostKeyFingerprint: FINGERPRINT });
    check("reject: the 'no passphrase' error names the real cause (not a generic failure)", /passphrase/i.test(noPassMsg));
    check("reject: the 'no passphrase' error never echoes the submitted key marker", !noPassMsg.includes(SUBMITTED_KEY_MARKER));
    const wrongPassMsg = throwsFor("encrypted key, WRONG passphrase", { name: "x", host: "h", user: "u", privateKey: enc.private, passphrase: "definitely-wrong", hostKeyFingerprint: FINGERPRINT });
    check("reject: the 'wrong passphrase' error names a passphrase problem", /passphrase/i.test(wrongPassMsg));
    check("reject: the 'wrong passphrase' error never echoes the submitted key marker", !wrongPassMsg.includes(SUBMITTED_KEY_MARKER));
    throwsFor("oversize key", { name: "x", host: "h", user: "u", privateKey: "x".repeat(CONNECTION_SECRET_MAX + 1), hostKeyFingerprint: FINGERPRINT });
    throwsFor("bad port", { name: "x", host: "h", port: 0, user: "u", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT });
    throwsFor("bad user", { name: "x", host: "h", user: "", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT });
    throwsFor("bad fingerprint", { name: "x", host: "h", user: "u", privateKey: unenc.private, hostKeyFingerprint: "garbage" });
    throwsFor("garbage (unparseable) key", { name: "x", host: "h", user: "u", privateKey: "not a key at all", hostKeyFingerprint: FINGERPRINT });

    // --- truncated-key create test (round 3, item 2): a REAL key with its LEADING base64 chars cut off
    // decodes to garbled bytes that fail ssh2's own "magic" check — ssh2 echoes those raw decoded bytes
    // verbatim into its own Error ("Unsupported OpenSSH key magic: <bytes>", keyParser.js) — stripSshKeyPassphrase
    // must classify that away (classifySshParseError, sshKey.ts) rather than let it reach createSshConnection's
    // thrown error (and, over REST, a 400 body). Truncating from the START (not the end) is what actually
    // reaches the vulnerable "magic" field, since that field is the first 15 decoded bytes.
    {
      const realBody = unenc.private.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
      const truncatedBody = realBody.slice(8);
      const truncatedKeyText = `-----BEGIN OPENSSH PRIVATE KEY-----\n${truncatedBody}\n-----END OPENSSH PRIVATE KEY-----\n`;
      const truncatedDecodedPrefix = Buffer.from(truncatedBody, "base64").subarray(0, 15).toString("latin1");
      const truncMsg = throwsFor("truncated key (garbled magic bytes)", { name: "x", host: "h", user: "u", privateKey: truncatedKeyText, hostKeyFingerprint: FINGERPRINT });
      check("reject: a truncated key's error never echoes the decoded submission bytes ssh2's own 'magic' error would carry", !truncMsg.includes(truncatedDecodedPrefix));
      check("reject: a truncated key's error is NOT ssh2's raw interpolated 'magic' message", !/Unsupported OpenSSH key magic/i.test(truncMsg));
      check("reject: a truncated key still throws a classified, non-empty error", truncMsg.length > 0);
    }

    check("reject: none of the rejected inputs wrote a row", db.listConnections().length === countBeforeRejects);

    // --- updateSshConnectionConfig: editable fields only ---
    const updated = updateSshConnectionConfig(db, created.id, { readOnly: false, commandAllowlist: [{ kind: "exact", pattern: "uptime" }] });
    check("update: readOnly flipped", updated.readOnly === false);
    check("update: commandAllowlist replaced", JSON.stringify(updated.commandAllowlist) === JSON.stringify([{ kind: "exact", pattern: "uptime" }]));
    check("update: shellSyntax stays false when omitted", updated.shellSyntax === false);
    const shellOn = updateSshConnectionConfig(db, created.id, { shellSyntax: true });
    check("update: shellSyntax:true accepted on a now read-write connection and round-trips", shellOn.shellSyntax === true && getConnectionMetadata(db, created.id).shellSyntax === true);
    let roWithShell = false;
    try { updateSshConnectionConfig(db, created.id, { readOnly: true }); } catch { roWithShell = true; }
    check("update: flipping readOnly back on while shellSyntax is stored true is refused (no partial write)", roWithShell && getConnectionMetadata(db, created.id).readOnly === false);
    const shellOff = updateSshConnectionConfig(db, created.id, { readOnly: true, shellSyntax: false });
    check("update: readOnly:true together with shellSyntax:false accepted", shellOff.readOnly === true && shellOff.shellSyntax === false);
    updateSshConnectionConfig(db, created.id, { readOnly: false });
    check("update: riskyCommandPatterns untouched when omitted", JSON.stringify(updated.riskyCommandPatterns) === JSON.stringify(DEFAULT_SSH_RISKY_COMMAND_PATTERNS));
    check("update: host/port/user/fingerprint untouched (not in the editable set)", updated.host === "10.0.0.5" && updated.port === 2222 && updated.user === "loom" && updated.hostKeyFingerprint === FINGERPRINT);
    check("update: the stored key is still the same after a config update", getSshPrivateKeyForUse(db, created.id) === decrypted);
    let updateThrew = false;
    try { updateSshConnectionConfig(db, created.id, { commandAllowlist: [{ kind: "bogus", pattern: "x" }] }); } catch { updateThrew = true; }
    check("update: an invalid patch throws (no partial write)", updateThrew);
    check("update: a rejected patch left the row unchanged", JSON.stringify(getConnectionMetadata(db, created.id).commandAllowlist) === JSON.stringify([{ kind: "exact", pattern: "uptime" }]));
    const apiKeyConn = createConnection(db, { name: "Not SSH", host: "example.com", authScheme: "api-key", secret: "sek" });
    let nonSshThrew = false;
    try { updateSshConnectionConfig(db, apiKeyConn.id, { readOnly: false }); } catch { nonSshThrew = true; }
    check("update: targeting a non-ssh connection throws", nonSshThrew);
    check("decrypt: getSshPrivateKeyForUse on a non-ssh row -> undefined", getSshPrivateKeyForUse(db, apiKeyConn.id) === undefined);

    deleteConnection(db, created.id);
    check("delete: row gone", db.getConnection(created.id) === undefined);

    db.close();
  }

  // ============ Part 2 — fail-closed: the agent-facing dispatch seam never resolves the key ============
  {
    const db = new Db(dbFile("p2.db"));
    const created = createSshConnection(db, {
      name: "Homelab VM", host: "10.0.0.7", user: "loom", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT,
    });
    const decryptedP2 = getSshPrivateKeyForUse(db, created.id);
    const KEY_MARKERS = deriveKeyMarkers(decryptedP2);
    check("(positive control) privateSectionBase64 marker is present in this connection's own decrypted/stored key", decryptedP2.includes(KEY_MARKERS.privateSectionBase64));
    const GUARD = { requestTimeoutMs: 5000, maxResponseBytes: 1000, rateLimitMax: 100, rateLimitWindowMs: 60000 };
    let fetchCalled = false;
    const fetchImpl = async () => { fetchCalled = true; return new Response("should never be reached", { status: 200 }); };
    const r = await performAuthenticatedRequest({ db, fetchImpl }, [created.id], GUARD, { connection: created.id, path: "/x" });
    check("dispatch: an ssh connection is refused by performAuthenticatedRequest (fail-closed)", r.ok === false);
    check("dispatch: the refusal never actually dispatched a fetch", fetchCalled === false);
    check("dispatch: the refusal never carries ANY key marker", !anyMarkerIn(KEY_MARKERS, JSON.stringify(r)));
    check("fail-closed: this connection is never listed in its own usable-connections list", !resolveUsableConnections(db, [created.id], null).some((c) => c.id === created.id));
    db.close();
  }

  // ============ Part 3 — HUMAN-ONLY REST CRUD via the REAL buildServer (app.inject) ============
  {
    const db = new Db(dbFile("p3.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    const bodies = []; // every response body — swept for the key marker + passphrase at the end.
    const inject = async (opts) => { const r = await app.inject(opts); bodies.push(r.payload); return r; };

    const create = await inject({ method: "POST", url: "/api/connections/ssh", payload: {
      name: "REST SSH", host: "10.0.0.8", port: 22, user: "loom", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT,
    } });
    const createdBody = JSON.parse(create.payload);
    check("REST POST /connections/ssh: create -> 201", create.statusCode === 201 && createdBody.authScheme === "ssh");
    check("REST POST: create response has NO key/secret field", !("privateKey" in createdBody) && !("secret" in createdBody) && !("secretBlob" in createdBody));
    const storedRow = db.getConnection(createdBody.id);
    check("REST POST: stored blob is encrypted (decrypts to the stripped key)", storedRow.secretBlob !== unenc.private && !(sshUtils.parseKey(decryptSecret(storedRow.secretBlob)) instanceof Error));

    // This connection's OWN markers, derived from its own decrypted/stored key (the REST layer never
    // decrypts itself, so we reach into the real store the same way a genuine leak-detection sweep must).
    const decryptedP3 = getSshPrivateKeyForUse(db, createdBody.id);
    const KEY_MARKERS = deriveKeyMarkers(decryptedP3);
    check("(positive control) privateSectionBase64 marker is present in this connection's own decrypted/stored key", decryptedP3.includes(KEY_MARKERS.privateSectionBase64));
    check("REST POST: create body has NO key marker", !anyMarkerIn(KEY_MARKERS, create.payload));

    const getList = await inject({ method: "GET", url: "/api/connections" });
    const listBody = JSON.parse(getList.payload);
    check("REST GET list: includes the ssh row with its non-secret fields", listBody.some((c) => c.id === createdBody.id && c.port === 22 && c.user === "loom" && c.readOnly === true));
    check("REST GET list: no key field on any row", listBody.every((r) => !("privateKey" in r) && !("secretBlob" in r)));

    // Validation 400s — none of these write a row.
    check("REST POST: missing user -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT } })).statusCode === 400);
    check("REST POST: missing privateKey -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", user: "u", hostKeyFingerprint: FINGERPRINT } })).statusCode === 400);
    check("REST POST: missing hostKeyFingerprint -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", user: "u", privateKey: unenc.private } })).statusCode === 400);
    check("REST POST: bad fingerprint -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", user: "u", privateKey: unenc.private, hostKeyFingerprint: "garbage" } })).statusCode === 400);
    check("REST POST: bad port -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", port: 999999, user: "u", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT } })).statusCode === 400);
    check("REST POST: oversize key -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", user: "u", privateKey: "x".repeat(CONNECTION_SECRET_MAX + 1), hostKeyFingerprint: FINGERPRINT } })).statusCode === 400);
    check("REST POST: encrypted key without passphrase -> 400", (await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h", user: "u", privateKey: enc.private, hostKeyFingerprint: FINGERPRINT } })).statusCode === 400);
    check("REST POST: a rejected create left the count unchanged", db.listConnections().length === 1);

    // PUT /api/connections/:id/ssh — editable config update.
    const put = await inject({ method: "PUT", url: `/api/connections/${createdBody.id}/ssh`, payload: { readOnly: false, riskyCommandPatterns: [{ kind: "exact", pattern: "rm -rf /" }] } });
    const putBody = JSON.parse(put.payload);
    check("REST PUT: update -> 200, readOnly flipped", put.statusCode === 200 && putBody.readOnly === false);
    const putShell = await inject({ method: "PUT", url: `/api/connections/${createdBody.id}/ssh`, payload: { shellSyntax: true } });
    check("REST PUT: shellSyntax:true on the read-write connection -> 200 and returned", putShell.statusCode === 200 && JSON.parse(putShell.payload).shellSyntax === true);
    const putShellRo = await inject({ method: "PUT", url: `/api/connections/${createdBody.id}/ssh`, payload: { readOnly: true } });
    check("REST PUT: readOnly:true while shellSyntax is on -> 400", putShellRo.statusCode === 400);
    const postShellRo = await inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n-shell", host: "h", user: "u", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT, shellSyntax: true } });
    check("REST POST: shellSyntax:true with default readOnly -> 400", postShellRo.statusCode === 400);
    await inject({ method: "PUT", url: `/api/connections/${createdBody.id}/ssh`, payload: { shellSyntax: false } });
    check("REST PUT: riskyCommandPatterns replaced", JSON.stringify(putBody.riskyCommandPatterns) === JSON.stringify([{ kind: "exact", pattern: "rm -rf /" }]));
    check("REST PUT: unknown id -> 400 (not a connection crash)", (await inject({ method: "PUT", url: "/api/connections/does-not-exist/ssh", payload: { readOnly: true } })).statusCode === 400);
    const putBadRule = await inject({ method: "PUT", url: `/api/connections/${createdBody.id}/ssh`, payload: { commandAllowlist: [{ kind: "bogus", pattern: "x" }] } });
    check("REST PUT: an invalid rule shape -> 400", putBadRule.statusCode === 400);

    // POST /api/connections/ssh/fingerprint (card b5565d4c) — the human-clicked "fetch & show" probe, against
    // a THROWAWAY loopback ssh2.Server (never a real host). The expected value is computed INDEPENDENTLY from
    // the generated host key, never from the route's own output. It must DISPLAY only: no row is written.
    {
      const hostKey = generateParseableEd25519(sshUtils);
      const expected = computeHostKeyFingerprint(sshUtils.parseKey(hostKey.public).getPublicSSH());
      const server = new sshDefault.Server({ hostKeys: [hostKey.private] }, (conn) => { conn.on("error", () => {}); });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const port = server.address().port;
      const before = db.listConnections().length;
      const fp = await inject({ method: "POST", url: "/api/connections/ssh/fingerprint", payload: { host: "127.0.0.1", port } });
      check("REST fingerprint: 200 + the loopback server's real host-key fingerprint", fp.statusCode === 200 && JSON.parse(fp.payload).fingerprint === expected);
      check("REST fingerprint: displays only — no connection row written", db.listConnections().length === before);
      await new Promise((r) => server.close(r));
      check("REST fingerprint: missing host -> 400", (await inject({ method: "POST", url: "/api/connections/ssh/fingerprint", payload: { port: 22 } })).statusCode === 400);
      check("REST fingerprint: bad port -> 400", (await inject({ method: "POST", url: "/api/connections/ssh/fingerprint", payload: { host: "127.0.0.1", port: 70000 } })).statusCode === 400);
      // The probe runs the create path's OWN host check (validateSshHost, shared with
      // validateSshConnectionInput), so the two can't drift: an oversized or control-character host is
      // refused BEFORE any dial, with a fixed message that never echoes the submitted host.
      const HOST_TOO_LONG = "host must be a non-empty string of at most 300 characters";
      const HOST_CONTROL = "host must not contain control characters";
      for (const [label, badHost, want] of [
        ["oversized host", "h".repeat(301), HOST_TOO_LONG],
        ["control-character host", "127.0.0.1\nzz-planted-host-echo", HOST_CONTROL],
        ["NUL in host", "127.0.0.1\u0000zz-planted-host-echo", HOST_CONTROL],
      ]) {
        const r = await inject({ method: "POST", url: "/api/connections/ssh/fingerprint", payload: { host: badHost, port } });
        check(`REST fingerprint: ${label} -> 400 with the fixed generic error`, r.statusCode === 400 && JSON.parse(r.payload).error === want);
        check(`REST fingerprint: ${label} — the error never echoes the submitted host`, !r.payload.includes("zz-planted-host-echo") && !r.payload.includes("h".repeat(301)));
        // Same input through the create path's validator: the identical refusal (one check, two callers).
        const v = validateSshConnectionInput({ name: "n", host: badHost, user: "u", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT });
        check(`create validator: ${label} refused with the same message as the probe`, v.ok === false && v.error === want);
      }
      // A closed port: the probe's own generic failure surfaces as a non-2xx, never a fingerprint.
      const closed = await inject({ method: "POST", url: "/api/connections/ssh/fingerprint", payload: { host: "127.0.0.1", port } });
      check("REST fingerprint: unreachable host -> 502 with no fingerprint", closed.statusCode === 502 && !("fingerprint" in JSON.parse(closed.payload)));
    }

    // DELETE (revoke) — the generic route, unchanged.
    const del = await inject({ method: "DELETE", url: `/api/connections/${createdBody.id}` });
    check("REST DELETE: -> ok + row gone", del.statusCode === 200 && db.getConnection(createdBody.id) === undefined);

    // The key marker / passphrase appear in NO response body across the whole REST sequence.
    check("REST: no key marker appears in ANY response body", bodies.every((b) => !anyMarkerIn(KEY_MARKERS, b)));
    check("REST: the passphrase string appears in NO response body", bodies.every((b) => !b.includes(PASSPHRASE)));

    await app.close();
    db.close();
  }

  // ============ Part 4 — HUMAN-ONLY: no MCP tool (setup / orchestration / platform) exposes ssh ========
  {
    const db = new Db(dbFile("p4.db"));
    const createdP4 = createSshConnection(db, { name: "MCP-visible probe", host: "10.0.0.9", user: "loom", privateKey: unenc.private, hostKeyFingerprint: FINGERPRINT });
    const decryptedP4 = getSshPrivateKeyForUse(db, createdP4.id);
    const KEY_MARKERS = deriveKeyMarkers(decryptedP4);
    check("(positive control) privateSectionBase64 marker is present in this connection's own decrypted/stored key", decryptedP4.includes(KEY_MARKERS.privateSectionBase64));
    class SeamHost extends createSeamHost(PtyHost) {
      createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, svc);
    const setup = new SetupMcpRouter(db, svc);
    const platform = new PlatformMcpRouter(db, svc);

    const listOf = async (server) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "connections-ssh-test", version: "0" });
      await client.connect(clientT);
      const tools = (await client.listTools()).tools;
      await client.close();
      return tools;
    };

    const mentionsSshByName = (tools) => tools.some((t) => /\bssh\b/i.test(t.name));
    const checkRouter = async (label, server) => {
      const tools = await listOf(server);
      check(`${label}: NO tool name mentions 'ssh'`, !mentionsSshByName(tools));
      check(`${label}: tools/list JSON does not contain ANY key marker`, !anyMarkerIn(KEY_MARKERS, JSON.stringify(tools)));
      return tools;
    };
    await checkRouter("orchestration (manager)", orch.buildServer("mgr-1", "manager"));
    await checkRouter("orchestration (worker)", orch.buildServer("wkr-1", "worker"));
    await checkRouter("orchestration (assistant)", orch.buildServer("assist-1", "assistant"));
    await checkRouter("setup", setup.buildServer());
    await checkRouter("platform", platform.buildServer("plat-1"));

    // --- round 3, item 2: the CORE loom-tasks router (mcp/server.ts), end to end — the one that hosts
    // `authenticated_request` and embeds the session's usable-connections list IN its description. A
    // session must have THIS ssh connection on its own `connections` allowlist (so the tool actually
    // registers at all) to meaningfully prove `resolveUsableConnections`' ssh-exclusion reaches the real
    // description text, not just the standalone function checked in Part 1. ---
    const now = new Date().toISOString();
    const PROJECT_ID = "pSshMcp";
    db.insertProject({ id: PROJECT_ID, name: "SshMcpProj", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
    // @decision afe1bc90 — the connection grant lives on the AGENT row, not the profile.
    db.insertProfile({ id: "profSsh", name: "SshRig", role: null, description: "", allowDelta: [], skills: null, model: null, icon: null });
    db.insertAgent({ id: "agentSsh", projectId: PROJECT_ID, name: "SshAgent", startupPrompt: "", position: 0, profileId: "profSsh", connections: [createdP4.id] });
    const sSsh = svc.startNew("agentSsh");
    check("core-tasks: session row pins the ssh connection id (so authenticated_request registers)", (db.getSession(sSsh.id).connections ?? []).includes(createdP4.id));

    const wakes = {};
    const throwFetch = async () => { throw new Error("unexpected real fetch in a tools/list-only test"); };
    const taskRouter = new TaskMcpRouter(db, wakes, throwFetch);
    const taskServer = taskRouter.buildServer(taskRouter.resolveProject(sSsh.id), sSsh.id);
    const taskTools = await checkRouter("core-tasks (loom-tasks)", taskServer);

    const authTool = taskTools.find((t) => t.name === "authenticated_request");
    check("core-tasks: authenticated_request IS registered (connections allowlist is non-empty)", authTool !== undefined);
    check("core-tasks: authenticated_request's description never names this connection's id", !authTool?.description.includes(createdP4.id));
    check("core-tasks: authenticated_request's description never names this connection's host", !authTool?.description.includes(createdP4.host));
    check("core-tasks: authenticated_request's description falls back to the 'none are currently resolvable' text (ssh is excluded from the usable list)", authTool?.description.includes("none are currently resolvable") ?? false);

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — ssh connections round-trip (encrypt/decrypt + same-key proof), validation rejects bad port/user/fingerprint/oversize key/encrypted-key-without-passphrase, the passphrase is stripped at create time and never stored, getSecretForUse/performAuthenticatedRequest/every MCP router's tools/list fail-closed with NO key marker ever appearing, human-only REST create+update CRUD works end to end, and updateSshConnectionConfig only ever touches the editable (readOnly/commandAllowlist/riskyCommandPatterns) fields."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
