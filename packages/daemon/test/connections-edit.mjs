import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 923dfc9d — the owner EDIT of an existing connection (PATCH /api/connections/:id for api-key/bearer/oauth2,
// PUT /api/connections/:id/ssh for ssh). SECURITY-CRITICAL, fully hermetic: temp LOOM_HOME, a REAL Db, the REAL
// envelope key, fastify `inject` (no listener), fixture ssh keys generated in pure JS. No network, no claude.
//
// One group per invariant, each a distinct failure the edit must refuse or preserve:
//   A. id/createdAt/grant-reach preserved; name/host/scheme/secret change and read back after a reload.
//   B. the secret is WRITE-ONLY: blank keeps the stored blob byte-for-byte, a value rotates it, and neither
//      value ever appears in a response, the list, the audit event, or any log line.
//   C. the `connection_updated` audit event: field NAMES + secretRotated only; none for a no-op edit.
//   D. name collision refused; renaming to its own name is not a collision.
//   E. host change re-validates a codexProvider binding (refused naming the profile; allowed when the hostname
//      still matches).
//   F. scheme/scope immutability: api-key<->bearer only; oauth2 name/host only; projectId immutable.
//   G. ssh: a host OR port change REQUIRES a new fingerprint; a user-only/key-only change does NOT; the key is
//      write-only; an edit changes the approval action (old holds stop matching).
//   H. wrong-kind / unknown-id routes.
// Run: 1) build (turbo builds shared first), 2) node test/connections-edit.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-conn-edit-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createConnection, createSshConnection, createOAuthConnection, listConnections, getConnectionMetadata, resolveUsableConnections, getSshPrivateKeyForUse } = await import("../dist/connections/store.js");
const { decryptSecret } = await import("../dist/keys/envelope.js");
const { sshApprovalAction } = await import("../dist/connections/sshApproval.js");
const { utils: sshUtils } = (await import("ssh2")).default;
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");

// Capture every console line during the edits so a leaked secret in a log is caught.
const logged = [];
for (const m of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[m].bind(console);
  console[m] = (...a) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); orig(...a); };
}

const db = new Db(path.join(tmpHome, "edit.db"));
const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});
const patch = (id, payload) => app.inject({ method: "PATCH", url: `/api/connections/${id}`, payload });
const putSsh = (id, payload) => app.inject({ method: "PUT", url: `/api/connections/${id}/ssh`, payload });
const events = () => db.listEventsSince(0, 5000).filter((e) => e.kind === "connection_updated");
const blobOf = (id) => db.getConnection(id).secretBlob;

const OLD_SECRET = "sk-OLD-secret-aaaaaaaaaaaaaaaa";
const NEW_SECRET = "sk-NEW-secret-bbbbbbbbbbbbbbbb";

// ============ A + B + C: api-key edit end to end ============
const conn = createConnection(db, { name: "Example API", host: "api.example.com", authScheme: "api-key", secret: OLD_SECRET });
const blob0 = blobOf(conn.id);

const rName = await patch(conn.id, { name: "Example API v2", secret: "" });
check("A: a name change is accepted (200)", rName.statusCode === 200 && rName.json().name === "Example API v2");
check("A: the id and createdAt are preserved", rName.json().id === conn.id && rName.json().createdAt === conn.createdAt);
check("B: a BLANK secret leaves the stored ciphertext byte-identical", blobOf(conn.id) === blob0);
check("C: a name-only edit files connection_updated with fields [name] and secretRotated:false",
  events().length === 1 && JSON.stringify(events()[0].detail.fields) === '["name"]' && events()[0].detail.secretRotated === false && events()[0].detail.connectionId === conn.id);

const rHost = await patch(conn.id, { host: "api2.example.com" });
check("A: a host change is accepted and reads back in the list", rHost.statusCode === 200 && listConnections(db).find((c) => c.id === conn.id).host === "api2.example.com");

const rRot = await patch(conn.id, { secret: NEW_SECRET });
check("B: a non-blank secret ROTATES the stored value (decrypts to the new one, not the old)", rRot.statusCode === 200 && decryptSecret(blobOf(conn.id)) === NEW_SECRET && blobOf(conn.id) !== blob0);
check("C: a rotation-only edit files fields [] with secretRotated:true", events().length === 3 && events()[2].detail.fields.length === 0 && events()[2].detail.secretRotated === true);
const wire = [rName.body, rHost.body, rRot.body, JSON.stringify(listConnections(db)), (await app.inject({ method: "GET", url: "/api/connections" })).body, JSON.stringify(events())].join("\n");
check("B: neither the old nor the new secret appears in any response, list read, or audit event", !wire.includes(OLD_SECRET) && !wire.includes(NEW_SECRET));
check("B: the response carries no secret-shaped key", !("secret" in rRot.json()) && !("secretBlob" in rRot.json()));
check("A: the usable-connection summary (what a granted session resolves) sees the new name+host under the SAME id",
  JSON.stringify(resolveUsableConnections(db, [conn.id])) === JSON.stringify([{ id: conn.id, name: "Example API v2", host: "api2.example.com" }]));
const before = events().length;
const rNoop = await patch(conn.id, { name: "Example API v2", host: "api2.example.com", secret: "" });
check("C: a no-op edit succeeds but files NO event", rNoop.statusCode === 200 && events().length === before);
const rScheme = await patch(conn.id, { authScheme: "bearer" });
check("F: api-key -> bearer is allowed", rScheme.statusCode === 200 && rScheme.json().authScheme === "bearer");
for (const bad of ["oauth2", "ssh", "nope"]) {
  const r = await patch(conn.id, { authScheme: bad });
  check(`F: authScheme ${bad} is refused (400) and the row is unchanged`, r.statusCode === 400 && db.getConnection(conn.id).authScheme === "bearer");
}
const rBadSecret = await patch(conn.id, { secret: 12345 });
check("B: a non-string secret is refused (400), blob unchanged", rBadSecret.statusCode === 400 && decryptSecret(blobOf(conn.id)) === NEW_SECRET);
const rEmptyName = await patch(conn.id, { name: "   " });
check("A: a blank name is refused (400)", rEmptyName.statusCode === 400 && db.getConnection(conn.id).name === "Example API v2");

// ============ D: name collisions ============
const other = createConnection(db, { name: "Other API", host: "other.example.com", authScheme: "api-key", secret: "sk-other" });
const rDup = await patch(other.id, { name: "Example API v2" });
check("D: renaming onto ANOTHER connection's name is refused (409), row unchanged", rDup.statusCode === 409 && db.getConnection(other.id).name === "Other API");
const rSelf = await patch(other.id, { name: "Other API", host: "other2.example.com" });
check("D: keeping its OWN name while editing the host is not a collision", rSelf.statusCode === 200);

// ============ E: host change re-validates the codexProvider binding ============
const bound = createConnection(db, { name: "Codex Key", host: "api.codex-host.example", authScheme: "api-key", secret: "sk-codex" });
const prof = await app.inject({ method: "POST", url: "/api/profiles", payload: { name: "Provider Rig", role: "worker", harness: "codex", codexProvider: { id: "myhost", baseUrl: "https://api.codex-host.example/v1", connectionId: bound.id } } });
check("E: fixture: a profile bound to the connection exists", prof.statusCode === 201);
const eBad = await patch(bound.id, { host: "api.moved.example" });
check("E: a host change that breaks the codexProvider binding is REFUSED (409) naming the profile; host unchanged",
  eBad.statusCode === 409 && /Provider Rig/.test(eBad.json().error) && db.getConnection(bound.id).host === "api.codex-host.example");
const eOk = await patch(bound.id, { host: "API.codex-host.example:8443" }); // host:port form — a scheme in the host is refused by validateConnectionHost
check("E: a host change whose HOSTNAME still equals the baseUrl host is allowed", eOk.statusCode === 200);
const eName = await patch(bound.id, { name: "Codex Key renamed" });
check("E: a non-host edit is never blocked by the binding", eName.statusCode === 200);
const unboundHost = await patch(other.id, { host: "anything.example" });
check("E: a connection no profile uses can move host freely", unboundHost.statusCode === 200);
// A combined {host, authScheme} edit is checked with the NEW scheme and the NEW host together.
const comboBad = await patch(bound.id, { host: "api.moved.example", authScheme: "bearer" });
check("E: a combined {host, authScheme} edit that breaks the binding is REFUSED (409); NEITHER field is applied",
  comboBad.statusCode === 409 && db.getConnection(bound.id).authScheme === "api-key" && db.getConnection(bound.id).host === "API.codex-host.example:8443");
const comboOk = await patch(bound.id, { host: "api.codex-host.example", authScheme: "bearer" });
check("E: a combined {host, authScheme} edit that keeps the binding applies BOTH fields",
  comboOk.statusCode === 200 && db.getConnection(bound.id).authScheme === "bearer" && db.getConnection(bound.id).host === "api.codex-host.example");

// ============ E2: a RESUMABLE SESSION's own pinned codexProvider also blocks a host change ============
// The profile no longer names this connection at all; only a session row pins it. A resume re-reads the row.
const pinnedConn = createConnection(db, { name: "Session Pinned", host: "api.pinned.example", authScheme: "api-key", secret: "sk-pinned" });
const pinnedProvider = { id: "myhost", baseUrl: "https://api.pinned.example/v1", connectionId: pinnedConn.id };
const sessionRow = (id, extra = {}) => ({
  id, projectId: "pX", agentId: "aX", engineSessionId: null, title: null, cwd: tmpHome, processState: "exited", resumability: "unknown",
  busy: false, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), lastError: null, role: "worker", gen: 0,
  harness: "codex", codexProvider: pinnedProvider, ...extra,
});
db.db.pragma("foreign_keys = OFF"); // fixture rows reference no real project/agent; the edit never reads them
db.insertSession(sessionRow("sess-pinned-resumable"));
check("E2: fixture: no PROFILE names the connection, only the session row does",
  !db.listProfiles().some((p) => p.codexProvider?.connectionId === pinnedConn.id) && db.listResumableSessionsWithCodexProvider().some((s) => s.id === "sess-pinned-resumable"));
const sessBad = await patch(pinnedConn.id, { host: "api.elsewhere.example" });
check("E2: a host change that would break a RESUMABLE session's pinned binding is REFUSED (409) naming the session; host unchanged",
  sessBad.statusCode === 409 && /resumable session\(s\) sess-pin/.test(sessBad.json().error) && db.getConnection(pinnedConn.id).host === "api.pinned.example");
const sessOkHost = await patch(pinnedConn.id, { host: "API.pinned.example:9443" });
check("E2: a host change whose hostname still matches the session's pinned baseUrl is allowed", sessOkHost.statusCode === 200);
const sessUnrelated = await patch(pinnedConn.id, { name: "Session Pinned renamed" });
check("E2: a non-host edit is never blocked by the session pin", sessUnrelated.statusCode === 200);
db.db.prepare("UPDATE sessions SET resumability = 'dead' WHERE id = ?").run("sess-pinned-resumable");
const sessDead = await patch(pinnedConn.id, { host: "api.elsewhere.example" });
check("E2: CONTROL: once the session is proven dead (can never resume) the same host change is allowed", sessDead.statusCode === 200);
const archivedConn = createConnection(db, { name: "Archived Pinned", host: "api.archived.example", authScheme: "api-key", secret: "sk-arch" });
db.insertSession(sessionRow("sess-pinned-archived", { codexProvider: { id: "myhost", baseUrl: "https://api.archived.example/v1", connectionId: archivedConn.id } }));
db.db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), "sess-pinned-archived");
const sessArchived = await patch(archivedConn.id, { host: "api.elsewhere.example" });
check("E2: CONTROL: an ARCHIVED session no longer blocks the host change", sessArchived.statusCode === 200);
db.db.pragma("foreign_keys = ON");

// ============ J: atomicity — a rejected edit applies NOTHING, an audit failure saves NOTHING ============
// Defined here, RUN after group G (it reuses the ssh fixture G creates).
const atomicityGroup = async () => {
const jBlob = blobOf(conn.id);
const jName = db.getConnection(conn.id).name;
const jEvents = events().length;
const jMixed = await patch(conn.id, { name: "should-not-stick", secret: 12345 });
check("J: PATCH {name, secret:12345} is rejected (400) and the NAME is unchanged (no partial apply)",
  jMixed.statusCode === 400 && db.getConnection(conn.id).name === jName && blobOf(conn.id) === jBlob && events().length === jEvents);
const jSsh = db.getConnection(ssh.id);
const jSshMixed = await putSsh(ssh.id, { host: "atomic.home.lan", hostKeyFingerprint: FP1, commandAllowlist: "bad" });
check("J: PUT /ssh {host, hostKeyFingerprint, commandAllowlist:'bad'} is rejected (400); host AND pin are unchanged",
  jSshMixed.statusCode === 400 && db.getConnection(ssh.id).host === jSsh.host && db.getConnection(ssh.id).sshHostKeyFingerprint === jSsh.sshHostKeyFingerprint && events().length === jEvents);
// The UPDATE and its audit row share ONE transaction: when the event write throws, the change is NOT saved.
const realAppend = db.appendEvent.bind(db);
let appendReached = 0;
db.appendEvent = () => { appendReached++; throw new Error("injected appendEvent failure"); };
const jApiAudit = await patch(conn.id, { name: "audit-fails", secret: "sk-should-not-save-cccccccccccc" });
check("J: when appendEvent throws, a PATCH saves NOTHING (name and ciphertext unchanged) and answers 500",
  appendReached === 1 && jApiAudit.statusCode === 500 && db.getConnection(conn.id).name === jName && blobOf(conn.id) === jBlob);
const sshBlobJ = blobOf(ssh.id);
const jSshAudit = await putSsh(ssh.id, { user: "audit-fails-user", privateKey: keyB.private });
check("J: when appendEvent throws, an ssh PUT saves NOTHING (user and key blob unchanged) and answers 500",
  appendReached === 2 && jSshAudit.statusCode === 500 && db.getConnection(ssh.id).sshUser === jSsh.sshUser && blobOf(ssh.id) === sshBlobJ);
db.appendEvent = realAppend;
const jOk = await patch(conn.id, { name: "audit-ok" });
check("J: CONTROL: with appendEvent restored the same kind of edit saves AND files its event", jOk.statusCode === 200 && events().length === jEvents + 1);
};

// ============ F: oauth2 + scope immutability ============
const oa = createOAuthConnection(db, { name: "OAuth One", host: "oauth.example.com", provider: "custom", clientId: "cid", clientSecret: "csecret-zzzz", authUrl: "https://a.example/auth", tokenUrl: "https://a.example/token", scopes: ["read"] });
const oaBlob = blobOf(oa.id);
const oOk = await patch(oa.id, { name: "OAuth Renamed", host: "oauth2.example.com" });
check("F: an oauth2 row takes name + host", oOk.statusCode === 200 && oOk.json().name === "OAuth Renamed" && oOk.json().host === "oauth2.example.com");
check("F: an oauth2 edit leaves the token bundle blob untouched", blobOf(oa.id) === oaBlob);
for (const [k, v] of [["clientId", "x"], ["clientSecret", "x"], ["secret", "x"], ["scopes", ["a"]], ["authUrl", "https://x.example"], ["authScheme", "api-key"], ["provider", "github"]]) {
  const r = await patch(oa.id, { [k]: v });
  check(`F: oauth2 ${k} is refused (400) with the field named, row unchanged`, r.statusCode === 400 && r.json().error.includes(k) && blobOf(oa.id) === oaBlob);
}
const rScope = await patch(conn.id, { projectId: "some-other-project" });
check("F: projectId is IMMUTABLE (400, field named)", rScope.statusCode === 400 && /projectId cannot be changed/.test(rScope.json().error));
const rScopeSame = await patch(conn.id, { projectId: null });
check("F: echoing the current projectId (null) is a harmless no-op", rScopeSame.statusCode === 200);
const rUnknown = await patch(conn.id, { colour: "red" });
check("F: an unknown field is refused (400)", rUnknown.statusCode === 400 && /colour/.test(rUnknown.json().error));

// ============ G: ssh ============
const keyA = generateParseableEd25519(sshUtils);
const keyB = generateParseableEd25519(sshUtils);
const FP1 = "SHA256:" + "A".repeat(43);
const FP2 = "SHA256:" + "B".repeat(43);
const ssh = createSshConnection(db, { name: "NAS", host: "nas.home.lan", port: 22, user: "loom", privateKey: keyA.private, hostKeyFingerprint: FP1 });
const sshBlob0 = blobOf(ssh.id);
const approvalBefore = sshApprovalAction(ssh, "uptime");

const gUser = await putSsh(ssh.id, { user: "deploy" });
check("G: a USER-only change needs NO re-pin (the pin is the host key) and keeps the pin", gUser.statusCode === 200 && gUser.json().user === "deploy" && gUser.json().hostKeyFingerprint === FP1);
check("G: a user-only edit files fields [user], secretRotated:false", JSON.stringify(events().at(-1).detail.fields) === '["user"]' && events().at(-1).detail.secretRotated === false);
const gHostNoFp = await putSsh(ssh.id, { host: "nas2.home.lan" });
check("G: a HOST change without a new fingerprint is REFUSED (400); host and pin unchanged", gHostNoFp.statusCode === 400 && /requires a new hostKeyFingerprint/.test(gHostNoFp.json().error) && db.getConnection(ssh.id).host === "nas.home.lan" && db.getConnection(ssh.id).sshHostKeyFingerprint === FP1);
const gPortNoFp = await putSsh(ssh.id, { port: 2222 });
check("G: a PORT change without a new fingerprint is REFUSED (400); port unchanged", gPortNoFp.statusCode === 400 && db.getConnection(ssh.id).sshPort === 22);
const gBadFp = await putSsh(ssh.id, { host: "nas2.home.lan", hostKeyFingerprint: "SHA256:short" });
check("G: a malformed fingerprint is refused (400)", gBadFp.statusCode === 400 && db.getConnection(ssh.id).host === "nas.home.lan");
const gHost = await putSsh(ssh.id, { host: "nas2.home.lan", hostKeyFingerprint: FP2 });
check("G: a host change WITH a new fingerprint re-pins in the same edit", gHost.statusCode === 200 && gHost.json().host === "nas2.home.lan" && gHost.json().hostKeyFingerprint === FP2);
check("G: that edit files fields [host, hostKeyFingerprint]", JSON.stringify(events().at(-1).detail.fields) === '["host","hostKeyFingerprint"]');
const gPort = await putSsh(ssh.id, { port: 2222, hostKeyFingerprint: FP2 });
check("G: a port change with an EXPLICIT pin EQUAL to the old one is accepted as an owner re-confirm (the old pin is never implicitly carried over)", gPort.statusCode === 200 && gPort.json().port === 2222 && gPort.json().hostKeyFingerprint === FP2);
const approvalAfter = sshApprovalAction(getConnectionMetadata(db, ssh.id), "uptime");
check("G: the ssh approval action CHANGED, so a hold filed for the old target no longer matches", approvalBefore !== approvalAfter);
check("G: the key blob is untouched by non-key edits", blobOf(ssh.id) === sshBlob0);
const gBlank = await putSsh(ssh.id, { privateKey: "", name: "NAS renamed" });
check("G: a blank privateKey keeps the stored key", gBlank.statusCode === 200 && blobOf(ssh.id) === sshBlob0);
const gPassNoKey = await putSsh(ssh.id, { passphrase: "x" });
check("G: a passphrase without a new key is refused (400)", gPassNoKey.statusCode === 400);
const pemBeforeRotation = getSshPrivateKeyForUse(db, ssh.id);
const gRot = await putSsh(ssh.id, { privateKey: keyB.private });
const pemAfterRotation = getSshPrivateKeyForUse(db, ssh.id);
check("G: a new privateKey ROTATES the stored key (the decrypted PEM differs from the old one)", gRot.statusCode === 200 && pemAfterRotation !== pemBeforeRotation && blobOf(ssh.id) !== sshBlob0);
check("G: the key rotation edit files secretRotated:true and no key material in the event", events().at(-1).detail.secretRotated === true && !JSON.stringify(events()).includes("PRIVATE KEY"));
const sshWire = [gUser.body, gHost.body, gRot.body, JSON.stringify(events())].join("\n");
const keyBody = (k) => k.private.split("\n").filter((l) => l && !l.includes("-----")).join("");
check("G: neither key's body appears in any ssh response or audit event", !sshWire.includes(keyBody(keyA).slice(10, 60)) && !sshWire.includes(keyBody(keyB).slice(10, 60)));
const gBadKey = await putSsh(ssh.id, { privateKey: "not a key at all" });
check("G: an unparseable replacement key is refused (400) and the stored key is unchanged", gBadKey.statusCode === 400 && !gBadKey.body.includes("not a key at all") && getSshPrivateKeyForUse(db, ssh.id) === pemAfterRotation);
const gColl = await putSsh(ssh.id, { name: "Example API v2" });
check("G: an ssh rename onto an existing name is refused (409)", gColl.statusCode === 409);
const gConfig = await putSsh(ssh.id, { readOnly: false, commandAllowlist: [{ kind: "exact", pattern: "uptime" }] });
check("G: the pre-existing config-only PUT shape still works", gConfig.statusCode === 200 && gConfig.json().readOnly === false && gConfig.json().commandAllowlist.length === 1);

await atomicityGroup();

// ============ H: wrong-kind / unknown id ============
const hSshViaPatch = await patch(ssh.id, { name: "x" });
check("H: PATCH on an ssh row is refused (400) pointing at the ssh route", hSshViaPatch.statusCode === 400 && /ssh/.test(hSshViaPatch.json().error));
const hApiViaPut = await putSsh(conn.id, { name: "x" });
check("H: PUT /ssh on a non-ssh row is refused (400)", hApiViaPut.statusCode === 400);
const hMissing = await patch("no-such-id", { name: "x" });
check("H: an unknown id is 404", hMissing.statusCode === 404);

// ============ B (logs) ============
const allLogs = logged.join("\n");
check("B: no secret, key body or passphrase appears in any console line emitted during the edits",
  !allLogs.includes(OLD_SECRET) && !allLogs.includes(NEW_SECRET) && !allLogs.includes(keyBody(keyA).slice(10, 60)) && !allLogs.includes(keyBody(keyB).slice(10, 60)));

await app.close();
db.close();
await finishAndExit(failures);
