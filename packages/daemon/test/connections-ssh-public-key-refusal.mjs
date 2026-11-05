import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c4e959be: pasting a PUBLIC key (or another non-private-key shape) into POST /api/connections/ssh must
// be a clean, fixed-text 400 refusal — never a thrown TypeError ("Cannot read properties of null (reading
// 'replace')": ssh2's getPrivatePEM() returns null for a public key) and never an echo of submitted bytes.
// Hermetic: temp LOOM_HOME, REAL Db + REAL buildServer (app.inject), pure-JS ssh2 fixture keys, no daemon.
//
// Run: 1) build, 2) node test/connections-ssh-public-key-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ssh-pub-${Date.now().toString(36)}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { stripSshKeyPassphrase } = await import("../dist/connections/sshKey.js");
const sshUtils = (await import("ssh2")).default.utils;

const FINGERPRINT = "SHA256:" + "A".repeat(43);
const PUBLIC_KEY_REFUSAL = "that is a public key; paste the PRIVATE key file";

// card 28c304b2: ssh2's generateKeyPairSync("ed25519") yields a malformed private key ~0.5% of the time —
// regenerate until the private half parses AND round-trips a sign/verify, same robustness as ssh-exec-tool.mjs.
function genKey(type, opts) {
  for (let i = 0; i < 20; i++) {
    const kp = sshUtils.generateKeyPairSync(type, opts);
    const priv = sshUtils.parseKey(kp.private, opts?.passphrase);
    const pub = sshUtils.parseKey(kp.public);
    if (priv instanceof Error || pub instanceof Error) continue;
    const nonce = Buffer.from("probe");
    const sig = priv.sign(nonce);
    if (sig instanceof Error || pub.verify(nonce, sig) !== true) continue;
    return kp;
  }
  throw new Error(`could not generate a sound ${type} fixture key`);
}

const ed = genKey("ed25519");
const rsa = genKey("rsa", { bits: 2048 });
const spkiPem = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
const certLikePem = "-----BEGIN CERTIFICATE-----\n" + Buffer.from("not really a certificate").toString("base64") + "\n-----END CERTIFICATE-----\n";
const pkcs8EncryptedLookalike = "-----BEGIN ENCRYPTED PRIVATE KEY-----\n" + Buffer.from("x".repeat(40)).toString("base64") + "\n-----END ENCRYPTED PRIVATE KEY-----\n";

// A distinctive slice of each submitted shape's key body — must NEVER appear in a response.
const bodyMarker = (text) => text.split("\n").filter((l) => l && !l.startsWith("-----") && !l.startsWith("ssh-") && !l.startsWith("Comment")).join("").slice(20, 52) || text.trim().slice(8, 40);
const edPubLine = ed.public.trim();

// [label, privateKey submitted, expected status, expected error text (exact), marker]
const PUBLIC_ROWS = [
  ["ed25519 OpenSSH public key line", ed.public, bodyMarker(ed.public)],
  ["rsa OpenSSH public key line", rsa.public, bodyMarker(rsa.public)],
  ["SPKI 'BEGIN PUBLIC KEY' PEM", spkiPem, bodyMarker(spkiPem)],
];
// Card b919b6fd: ssh2 messages that interpolate text DECODED FROM THE SUBMISSION (keyParser.js :478, :484, :493,
// :831/:838, :1314/:1387). Each fixture plants a distinctive marker where ssh2 reads it; the 400 body must not
// carry it. Fixtures are synthetic envelopes — no real key material anywhere.
const sshStr = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
const opensshArmor = (body) => "-----BEGIN OPENSSH PRIVATE KEY-----\n" + body.toString("base64").replace(/.{1,70}/g, "$&\n").trimEnd() + "\n-----END OPENSSH PRIVATE KEY-----";
const MAGIC = Buffer.from("openssh-key-v1\0", "binary");
const pad = Buffer.alloc(40, 1);
const CIPHER_MARKER = "LEAKCIPHERMARKER", KDF_MARKER = "LEAKKDFMARKER", DEK_MARKER = "LEAKDEKMARKER", PUBTYPE_MARKER = "LEAKPUBTYPEMARKER";
const cipherKey = opensshArmor(Buffer.concat([MAGIC, sshStr(CIPHER_MARKER), sshStr("none"), sshStr(""), pad]));
const kdfKey = opensshArmor(Buffer.concat([MAGIC, sshStr("aes256-ctr"), sshStr(KDF_MARKER), sshStr(""), pad]));
const dekKey = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: ${DEK_MARKER},00112233445566778899AABBCCDDEEFF\n\n${Buffer.alloc(48, 7).toString("base64")}\n-----END RSA PRIVATE KEY-----`;
const pubTypeKey = `ssh-${PUBTYPE_MARKER} ${Buffer.concat([sshStr(`ssh-${PUBTYPE_MARKER}`), sshStr("x")]).toString("base64")}`;
const GENERIC = "invalid private key: could not read this private key";
const OTHER_ROWS = [
  ["ssh2 cipher-name echo (:484)", cipherKey, GENERIC, CIPHER_MARKER],
  ["ssh2 kdf-name echo (:493)", kdfKey, GENERIC, KDF_MARKER],
  ["ssh2 PEM DEK-Info cipher echo (:831)", dekKey, GENERIC, DEK_MARKER],
  // Observed: ssh2 answers this shape "Unsupported key format" (no echo) — the :1314/:1387 echo is not reachable from
  // here, so assert marker-absence only; the allowlist would collapse the echoing wording anyway.
  ["ssh2 public-key-type echo (:1314/:1387)", pubTypeKey, null, PUBTYPE_MARKER],
  ["empty string", "", "privateKey must be a non-empty string of at most 8192 characters", null],
  ["whitespace only", "  \n\t ", "privateKey must be a non-empty string of at most 8192 characters", null],
  ["PEM of another type (CERTIFICATE)", certLikePem, null, bodyMarker(certLikePem)],
  ["ENCRYPTED PRIVATE KEY lookalike garbage", pkcs8EncryptedLookalike, null, bodyMarker(pkcs8EncryptedLookalike)],
];

try {
  const db = new Db(path.join(tmpHome, "t.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const post = (privateKey) => app.inject({ method: "POST", url: "/api/connections/ssh", payload: { name: "n", host: "h.example", user: "u", privateKey, hostKeyFingerprint: FINGERPRINT } });

  // Positive control: a real private key still creates (the refusal didn't break the happy path).
  const okRes = await post(ed.private);
  check("control: a real ed25519 PRIVATE key -> 201", okRes.statusCode === 201);
  const countAfterControl = db.listConnections().length;

  // Control for the marker mechanism: the markers really ARE substrings of the submitted text.
  for (const [label, key, marker] of PUBLIC_ROWS) check(`(positive control) marker is in the submitted text: ${label}`, marker.length >= 8 && key.includes(marker));
  // lesson 319: the never-echo assertion must FLIP under a planted leak.
  check("(planted-leak control) a body that echoes the marker IS detected", JSON.stringify({ error: `bad: ${PUBLIC_ROWS[0][2]}` }).includes(PUBLIC_ROWS[0][2]));

  for (const [label, key, marker] of PUBLIC_ROWS) {
    const res = await post(key);
    const body = res.payload;
    let parsed = null; try { parsed = JSON.parse(body); } catch { /* asserted below */ }
    console.log(`  [observed] ${label}: status=${res.statusCode} body=${body.length > 200 ? body.slice(0, 200) + "…" : body}`);
    check(`public key (${label}): status 400`, res.statusCode === 400);
    check(`public key (${label}): fixed refusal text`, parsed?.error === PUBLIC_KEY_REFUSAL);
    check(`public key (${label}): no key material / TypeError text / stack in the body`, !body.includes(marker) && !/TypeError|Cannot read|\.replace|\bat \w+.*\(.*:\d+/.test(body));
  }
  for (const [label, key, expectedText, marker] of OTHER_ROWS) {
    const res = await post(key);
    const body = res.payload;
    let parsed = null; try { parsed = JSON.parse(body); } catch { /* asserted below */ }
    console.log(`  [observed] ${label}: status=${res.statusCode} body=${body.length > 200 ? body.slice(0, 200) + "…" : body}`);
    check(`${label}: status 400`, res.statusCode === 400);
    check(`${label}: a clean non-empty error string`, typeof parsed?.error === "string" && parsed.error.length > 0);
    if (expectedText) check(`${label}: exact fixed error text`, parsed?.error === expectedText);
    check(`${label}: no key material / TypeError text / stack in the body`, (marker === null || !body.includes(marker)) && !/TypeError|Cannot read|\.replace/.test(body));
  }

  // Direct function level: never throws for any of these shapes.
  for (const [label, key] of [...PUBLIC_ROWS, ...OTHER_ROWS]) {
    let threw = false; let r;
    try { r = stripSshKeyPassphrase(key, undefined); } catch { threw = true; }
    check(`stripSshKeyPassphrase never throws: ${label}`, !threw && r?.ok === false);
  }
  // A private key passes with a (non-matching) public line appended? No - just prove the public line alone is refused by name.
  check("direct: the public key line is refused with the fixed text", stripSshKeyPassphrase(edPubLine, undefined).error === PUBLIC_KEY_REFUSAL);

  check("no refused submission wrote a row", db.listConnections().length === countAfterControl);

  // Positive control (marker mechanism): each planted marker really IS in the submitted text.
  for (const [label, key, , marker] of OTHER_ROWS.slice(0, 4)) check(`(positive control) marker is in the submitted text (raw or base64-decoded): ${label}`, key.includes(marker) || Buffer.from(key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64").includes(marker));
  // Every allowlisted message still passes through: encrypted key with no / a wrong passphrase.
  const encKp = genKey("ed25519", { passphrase: "pp-for-allowlist-control", cipher: "aes256-ctr" });
  check("allowlist: encrypted key, no passphrase -> ssh2's fixed 'no passphrase given' text still forwarded", /no passphrase given/.test(stripSshKeyPassphrase(encKp.private, undefined).error ?? ""));
  check("allowlist: encrypted key, wrong passphrase -> fixed 'bad passphrase' text still forwarded", /bad passphrase/i.test(stripSshKeyPassphrase(encKp.private, "wrong").error ?? ""));
  // NIT: a valid private key with a public-key PEM block appended is NOT refused as "a public key".
  // (ssh2 itself may still reject the concatenation as unparseable; the NIT is only that it is not misnamed "a public key".)
  check("armor: private key + appended PUBLIC KEY block is NOT refused as 'that is a public key'", stripSshKeyPassphrase(rsa.private + "\n" + spkiPem, undefined).error !== PUBLIC_KEY_REFUSAL);

  // MINOR: a server fault is a fixed 500 that names no path; a caller error stays a 400 with its fixed text.
  const putBad = await app.inject({ method: "PUT", url: "/api/connections/no-such-id/ssh", payload: { readOnly: true } });
  check("PUT unknown id -> 400 fixed validation text", putBad.statusCode === 400 && JSON.parse(putBad.payload).error === "no ssh connection with that id");
  const { SECRET_KEY_PATH } = await import("../dist/paths.js");
  fs.mkdirSync(path.dirname(SECRET_KEY_PATH), { recursive: true });
  const goodKeyBytes = fs.existsSync(SECRET_KEY_PATH) ? fs.readFileSync(SECRET_KEY_PATH) : null;
  fs.writeFileSync(SECRET_KEY_PATH, Buffer.alloc(5, 1)); // wrong length -> envelope throws "envelope key at <path> has unexpected length"
  const origErr = console.error; const logged = []; console.error = (...a) => { logged.push(a.join(" ")); };
  let faultRes;
  try { faultRes = await post(ed.private); } finally { console.error = origErr; if (goodKeyBytes) fs.writeFileSync(SECRET_KEY_PATH, goodKeyBytes); }
  console.log(`  [observed] envelope fault: status=${faultRes.statusCode} body=${faultRes.payload}`);
  check("envelope-key fault -> 500", faultRes.statusCode === 500);
  check("envelope-key fault -> fixed text", JSON.parse(faultRes.payload).error === "could not save the connection");
  check("envelope-key fault: body names no secret-key path / 'envelope' / tmp home", !/envelope|unexpected length|loom-ssh-pub|secret/i.test(faultRes.payload));
  check("envelope-key fault: server log lines carry no path or key marker", logged.length > 0 && logged.every((l) => !l.includes(tmpHome) && !l.includes(bodyMarker(ed.private))));
  check("envelope-key fault wrote no row", db.listConnections().length === countAfterControl);

  await app.close();
  db.close();
  console.log(failures === 0 ? "\n✅ ALL PASS — non-private-key submissions are refused cleanly (fixed text, no echo, no throw)." : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
