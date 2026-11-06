import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The EDIT paths (PATCH /api/connections/:id, PUT /api/connections/:id/ssh) go through the SAME shared host
// validator as create: a scheme / path / whitespace / `:443` is refused on a https-kind edit, a host carrying
// a port is refused on an ssh edit, a valid edit lands, and a stored legacy-invalid host that is merely
// RESENT unchanged does not block the rest of the form. Hermetic: temp LOOM_HOME, REAL Db, fastify inject.
//
// Run: 1) build (turbo builds shared first), 2) node test/connections-edit-host-validation.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-conn-edit-host-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createConnection, createSshConnection, getConnectionMetadata } = await import("../dist/connections/store.js");
const { utils: sshUtils } = (await import("ssh2")).default;
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");

const db = new Db(path.join(tmpHome, "edit-host.db"));
const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});
const patch = (id, payload) => app.inject({ method: "PATCH", url: `/api/connections/${id}`, payload });
const putSsh = (id, payload) => app.inject({ method: "PUT", url: `/api/connections/${id}/ssh`, payload });
const FP = "SHA256:" + "A".repeat(43);

const api = createConnection(db, { name: "Plex", host: "plex.lan:32400", authScheme: "api-key", secret: "s" });
const ssh = createSshConnection(db, { name: "NAS", host: "nas.lan", port: 22, user: "loom", privateKey: generateParseableEd25519(sshUtils).private, hostKeyFingerprint: FP });

// ---- https kinds: PATCH ----
for (const [label, host, re] of [
  ["a scheme (http://x)", "http://x", /remove the scheme/],
  ["a path (x/path)", "plex.lan/path", /path/],
  ["whitespace", "plex lan", /whitespace/],
  ["a :443 port", "plex.lan:443", /drop ':443'/],
]) {
  const r = await patch(api.id, { host });
  check(`PATCH host with ${label} is refused (400, clear message)`, r.statusCode === 400 && re.test(r.json().error));
  check(`PATCH host with ${label}: the stored host is unchanged`, getConnectionMetadata(db, api.id).host === "plex.lan:32400");
}
const okPatch = await patch(api.id, { host: "plex2.lan:8443" });
check("PATCH a valid host:port edit is accepted and stored", okPatch.statusCode === 200 && getConnectionMetadata(db, api.id).host === "plex2.lan:8443");

// ---- ssh: PUT ----
const sshPort = await putSsh(ssh.id, { host: "nas.lan:22", hostKeyFingerprint: FP });
check("ssh PUT host:22 is refused (400) pointing at the port field", sshPort.statusCode === 400 && /port field/.test(sshPort.json().error));
const sshUrl = await putSsh(ssh.id, { host: "ssh://nas.lan", hostKeyFingerprint: FP });
check("ssh PUT with a scheme is refused (400)", sshUrl.statusCode === 400 && /remove the scheme/.test(sshUrl.json().error));
check("ssh PUT refusals leave the stored host unchanged", getConnectionMetadata(db, ssh.id).host === "nas.lan");
const sshOk = await putSsh(ssh.id, { host: "nas2.lan", hostKeyFingerprint: FP });
check("ssh PUT a valid bare-host edit is accepted and stored", sshOk.statusCode === 200 && getConnectionMetadata(db, ssh.id).host === "nas2.lan");

// ---- a stored legacy-invalid host resent UNCHANGED must not block the rest of the edit ----
const legacy = db.createConnection({ name: "Legacy", host: "http://192.168.178.136:32400", authScheme: "api-key", secretBlob: "x", projectId: null });
const resend = await patch(legacy.id, { name: "Legacy renamed", host: "http://192.168.178.136:32400" });
check("PATCH resending an unchanged invalid host still saves the other fields", resend.statusCode === 200 && getConnectionMetadata(db, legacy.id).name === "Legacy renamed");
check("…and the row stays flagged invalidHost", getConnectionMetadata(db, legacy.id).invalidHost === true);
const fixIt = await patch(legacy.id, { host: "192.168.178.136:32400" });
check("PATCH replacing it with a valid host:port clears the flag", fixIt.statusCode === 200 && getConnectionMetadata(db, legacy.id).invalidHost === undefined);
const stillBad = await patch(legacy.id, { host: "https://192.168.178.136:32400" });
check("PATCH changing it to ANOTHER invalid host is refused", stillBad.statusCode === 400);

await app.close();
db.close();
await finishAndExit(failures);
