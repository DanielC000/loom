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
const OTHER_ROWS = [
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

  await app.close();
  db.close();
  console.log(failures === 0 ? "\n✅ ALL PASS — non-private-key submissions are refused cleanly (fixed text, no echo, no throw)." : `\n❌ ${failures} FAILURE(S).`);
} finally {
  cleanupPathSync(tmpHome);
}
process.exit(failures === 0 ? 0 : 1);
