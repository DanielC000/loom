import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The ONE shared connection-host validator (`validateConnectionHost`) + every create path that must call it
// + the `invalidHost` metadata flag for a row stored before the validator existed. Hermetic: a REAL Db on a
// temp LOOM_HOME, no network, no daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-host-validation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-connhost-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  validateConnectionHost, validateSshHost, validateConnectionInput, validateSshConnectionInput,
  createConnection, createOAuthConnection, listConnections, getConnectionMetadata,
} = await import("../dist/connections/store.js");

const db = new Db();
try {
  const okH = (h, kind = "https") => validateConnectionHost(h, kind).ok === true;
  const badH = (h, kind, re) => { const r = validateConnectionHost(h, kind); return r.ok === false && re.test(r.error); };

  // ---- https kinds (api-key / bearer / oauth2) ----
  check("https: bare host accepted", okH("api.example.com"));
  check("https: bare IPv4 accepted", okH("192.168.178.136"));
  check("https: host:port accepted", okH("192.168.178.136:32400"));
  check("https: bracketed IPv6 with port accepted", okH("[fd00::1]:8443"));
  check("https: surrounding whitespace is trimmed, not refused", okH("  api.example.com  "));
  check("https: 'http://x' refused as a URL, message says to remove the scheme", badH("http://x", "https", /remove the scheme/));
  check("https: 'https://x' refused", badH("https://api.example.com", "https", /remove the scheme/));
  check("https: the Plex row's exact value 'http://192.168.178.136:32400' refused", badH("http://192.168.178.136:32400", "https", /bare hostname/));
  check("https: 'x/path' refused", badH("api.example.com/v1", "https", /path/));
  check("https: query / fragment / userinfo / backslash refused",
    badH("x?y=1", "https", /path/) && badH("x#f", "https", /path/) && badH("u@x", "https", /path/) && badH("x\\y", "https", /path/));
  check("https: embedded whitespace refused", badH("api example.com", "https", /whitespace/));
  check("https: embedded newline refused", badH("api.example.com\nx", "https", /control/));
  check("https: ':443' refused with a drop-it message", badH("api.example.com:443", "https", /drop ':443'/));
  check("https: port 0 / 65536 / non-numeric / leading zero refused",
    badH("x:0", "https", /port/) && badH("x:65536", "https", /port/) && badH("x:abc", "https", /port/) && badH("x:08080", "https", /port/));
  check("https: port 65535 and 1 accepted", okH("x:65535") && okH("x:1"));
  check("https: unbracketed IPv6 refused (would be ambiguous with a port)", badH("fd00::1", "https", /brackets/));
  check("https: a mixed-case host is accepted (same server; the request builder compares case-insensitively)", okH("API.Example.com"));
  {
    const { performAuthenticatedRequest } = await import("../dist/connections/request.js");
    const { resolveConfig } = await import("@loom/shared");
    const mixed = createConnection(db, { name: "mixed", host: "API.Example.com", authScheme: "bearer", secret: "tok" });
    let fetched = null;
    const fetchImpl = async (url) => { fetched = String(url); return new Response("ok", { status: 200 }); };
    const guard = resolveConfig(undefined, db.getPlatformConfig()).platform.connections;
    const res = await performAuthenticatedRequest({ db, fetchImpl }, [mixed.id], guard, { connection: mixed.id, path: "/v1" }, null);
    check("request: a mixed-case stored host resolves and calls the lowercased https URL", res.ok === true && fetched === "https://api.example.com/v1");
    db.deleteConnection(mixed.id);
  }
  // Hosts the request builder ALWAYS refuses must be refused (and flagged) here too — the validator ends in
  // the SAME round-trip `buildRequestUrl` asserts (connections/hostForm.ts).
  {
    const { performAuthenticatedRequest } = await import("../dist/connections/request.js");
    const { resolveConfig } = await import("@loom/shared");
    const guard = resolveConfig(undefined, db.getPlatformConfig()).platform.connections;
    let dialled = 0;
    const fetchImpl = async () => { dialled++; return new Response("ok", { status: 200 }); };
    const NON_CANONICAL = [
      ["IDN bücher.de", "bücher.de", /ASCII/],
      ["uncompressed IPv6 [FD00:0:0::1]:8443", "[FD00:0:0::1]:8443", /canonical host form/],
      ["IPv4 shorthand 0x7f.1", "0x7f.1", /canonical host form/],
      ["percent-escapes exa%41mple.com", "exa%41mple.com", /percent-escapes/],
      ["bracketed IPv4 [1.2.3.4]", "[1.2.3.4]", /canonical host form/],
    ];
    for (const [label, h, re] of NON_CANONICAL) {
      check(`https: ${label} refused with a class message`, badH(h, "https", re));
      check(`https: ${label} is refused at create too`, validateConnectionInput({ name: "n", host: h, authScheme: "bearer", secret: "s" }).ok === false);
      const stored = db.createConnection({ name: `nc-${label}`, host: h, authScheme: "bearer", secretBlob: "x", projectId: null });
      check(`https: ${label} — an already-stored row is flagged invalidHost`, getConnectionMetadata(db, stored.id).invalidHost === true);
      const res = await performAuthenticatedRequest({ db, fetchImpl }, [stored.id], guard, { connection: stored.id, path: "/v1" }, null);
      check(`https: ${label} — the request builder really refuses it (so the validator agrees with it), nothing dialled`, res.ok === false && dialled === 0);
      db.deleteConnection(stored.id);
    }
    check("https: control — compressed IPv6 with port, plain IPv4, lowercase host:port and a punycode name are ACCEPTED",
      okH("[fd00::1]:8443") && okH("192.168.178.136") && okH("plex.lan:32400") && okH("xn--bcher-kva.de"));
    check("https: control — a bracketed IPv6 in upper case is accepted only when it is already canonical", okH("[FD00::1]:8443"));
    check("ssh: the https-only round-trip does not apply (a bare ssh host that URL would rewrite is not newly refused)", okH("0x7f.1", "ssh"));
  }
  check("https: empty / blank / non-string refused", !okH("") && !okH("   ") && !okH(undefined) && !okH(42));
  check("https: over-long refused", !okH("a".repeat(301)));

  // ---- ssh kind ----
  check("ssh: bare host and bare IPv4 accepted", okH("pve.lan", "ssh") && okH("192.168.178.10", "ssh"));
  check("ssh: unbracketed IPv6 accepted", okH("fd00::1", "ssh"));
  check("ssh: a host carrying a port refused, message points at the port field", badH("pve.lan:22", "ssh", /port field/));
  check("ssh: a bracketed host carrying a port refused", badH("[fd00::1]:22", "ssh", /port field/));
  check("ssh: a scheme refused", badH("ssh://pve.lan", "ssh", /remove the scheme/));
  check("ssh: a path / whitespace refused", badH("pve.lan/x", "ssh", /path/) && badH("pve lan", "ssh", /whitespace/));
  check("validateSshHost IS the ssh form of the shared validator (no private copy)",
    validateSshHost("pve.lan:22").ok === false && validateSshHost("pve.lan").ok === true);
  check("validateSshConnectionInput refuses a url host before anything else about the key",
    validateSshConnectionInput({ name: "n", host: "http://x", user: "u", privateKey: "k", hostKeyFingerprint: "SHA256:" + "A".repeat(43) }).ok === false);

  // ---- every create path calls it ----
  check("validateConnectionInput refuses 'http://x'", validateConnectionInput({ name: "n", host: "http://x", authScheme: "bearer", secret: "s" }).ok === false);
  check("validateConnectionInput accepts host:port", validateConnectionInput({ name: "n", host: "x.lan:8443", authScheme: "bearer", secret: "s" }).ok === true);
  let threw = "";
  try { createConnection(db, { name: "bad", host: "x/path", authScheme: "api-key", secret: "s" }); } catch (e) { threw = String(e.message); }
  check("createConnection throws on 'x/path' and persists no row", /path/.test(threw) && listConnections(db).length === 0);
  const good = createConnection(db, { name: "good", host: "plex.lan:32400", authScheme: "api-key", secret: "s" });
  check("createConnection stores a host:port row, with no invalidHost flag", good.host === "plex.lan:32400" && !("invalidHost" in good));
  threw = "";
  try {
    createOAuthConnection(db, { name: "o", host: "https://accounts.example.com", provider: "custom", clientId: "c", clientSecret: "s", authUrl: "https://a.example/auth", tokenUrl: "https://a.example/tok", scopes: [] });
  } catch (e) { threw = String(e.message); }
  check("createOAuthConnection refuses a scheme in host", /remove the scheme/.test(threw));

  // ---- an EXISTING bad row (written before the validator) is flagged, not rewritten ----
  const stored = db.createConnection({ name: "Plex", host: "http://192.168.178.136:32400", authScheme: "api-key", secretBlob: "x", projectId: null });
  const meta = getConnectionMetadata(db, stored.id);
  check("a stored url-in-host row reads back invalidHost:true with a fixed reason", meta.invalidHost === true && /bare hostname/.test(meta.invalidHostReason));
  check("the stored host is left exactly as it was", meta.host === "http://192.168.178.136:32400");
  check("the reason never echoes the host", !String(meta.invalidHostReason).includes("192.168"));
  check("listConnections flags the bad row and not the good one",
    listConnections(db).find((c) => c.name === "Plex")?.invalidHost === true && listConnections(db).find((c) => c.name === "good")?.invalidHost === undefined);
  const sshBad = db.createConnection({ name: "SshBad", host: "pve.lan:22", authScheme: "ssh", secretBlob: "x", projectId: null, sshPort: 22, sshUser: "u", sshHostKeyFingerprint: "SHA256:" + "A".repeat(43), sshReadOnly: true });
  check("a stored ssh host carrying a port is flagged too", getConnectionMetadata(db, sshBad.id).invalidHost === true);
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
