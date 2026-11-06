import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 055b1fbf — the agent prompt lint's `ssh_exec` estimate must use the SAME predicate the real
// registration uses (resolveUsableSshConnections), not "any connection granted". HERMETIC: a REAL Db on a
// temp LOOM_HOME, real connection rows, the real lint entry points; no daemon, no network.
// Pins: (1) a usable SSH grant -> ssh_exec AND authenticated_request on the surface; (2) only a non-SSH
// grant -> authenticated_request but NOT ssh_exec; (3) a profile row carrying DORMANT legacy `connections`
// adds neither; (4) a project-scoped SSH connection of ANOTHER project is not usable -> no ssh_exec.
// Run: 1) build, 2) node test/agent-prompt-lint-ssh-exec.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-aplssh-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createSshConnection, createConnection } = await import("../dist/connections/store.js");
const { computeHostKeyFingerprint } = await import("../dist/connections/ssh.js");
const { agentCreatePromptWarning, agentUpdatePromptWarning } = await import("../dist/agents/promptLint.js");
const { utils } = (await import("ssh2")).default;
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");

try {
  // ssh2's raw ed25519 generator is malformed ~1 in 256 (card 28c304b2) — always go through the retry helper.
  const kp = generateParseableEd25519(utils);
  const hostFp = computeHostKeyFingerprint(utils.parseKey(generateParseableEd25519(utils).public).getPublicSSH());
  const db = new Db(path.join(tmpHome, "t.db"));
  const now = new Date().toISOString();
  for (const id of ["pA", "pB"]) db.insertProject({ id, name: id, repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  const ssh = createSshConnection(db, { name: "SSHGLOBAL", host: "127.0.0.1", port: 22, user: "loom", privateKey: kp.private, hostKeyFingerprint: hostFp });
  const sshB = createSshConnection(db, { name: "SSHPROJB", host: "127.0.0.1", port: 22, user: "loom", privateKey: kp.private, hostKeyFingerprint: hostFp, projectId: "pB" });
  const bearer = createConnection(db, { name: "Bearer", host: "api.example", authScheme: "bearer", secret: "sk-not-ssh-123456" });
  db.insertProfile({ id: "profW", name: "Rig", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, browserTesting: false });

  const PROMPT = "Use ssh_exec to inspect the host, and authenticated_request for the API.";
  const offending = (warning) => ({
    ssh: !!warning && /\bssh_exec\b/.test(warning),
    auth: !!warning && /\bauthenticated_request\b/.test(warning),
  });
  const lint = (connections, projectId = "pA", profileId = "profW") =>
    offending(agentCreatePromptWarning(db, { startupPrompt: PROMPT, profileId, connections, projectId }));

  // Control: no grants at all -> both are off-surface (shows the probe can see both names).
  let r = lint([]);
  check("control: no grants -> ssh_exec AND authenticated_request flagged", r.ssh && r.auth);

  r = lint([ssh.id]);
  check("(1) usable SSH grant -> ssh_exec and authenticated_request both on-surface", !r.ssh && !r.auth);

  r = lint([bearer.id]);
  check("(2) non-SSH grant only -> authenticated_request on-surface, ssh_exec flagged", !r.auth && r.ssh);

  // (3) dormant legacy profile `connections` (cards afe1bc90): set the dead column directly.
  db.db.prepare("UPDATE profiles SET connections = ? WHERE id = ?").run(JSON.stringify([ssh.id, bearer.id]), "profW");
  r = lint([]);
  check("(3) dormant profile-row connections add neither tool", r.ssh && r.auth);

  r = lint([ssh.id], "pA");
  check("(3b) agent grant still wins over a profile carrying dormant grants", !r.ssh && !r.auth);

  r = lint([sshB.id], "pA");
  check("(4) another project's scoped SSH connection is not usable -> ssh_exec flagged", r.ssh);
  r = lint([sshB.id], "pB");
  check("(4b) the owning project's scoped SSH connection is usable -> ssh_exec on-surface", !r.ssh);

  // The update path threads the existing agent row's projectId.
  const upd = offending(agentUpdatePromptWarning(db,
    { startupPrompt: PROMPT, profileId: "profW", connections: [bearer.id], projectId: "pA" }, {}));
  check("update path: non-SSH-only agent row -> ssh_exec flagged", upd.ssh && !upd.auth);
  const upd2 = offending(agentUpdatePromptWarning(db,
    { startupPrompt: PROMPT, profileId: "profW", connections: [ssh.id], projectId: "pA" }, {}));
  check("update path: SSH agent row -> ssh_exec on-surface", !upd2.ssh && !upd2.auth);
  db.close?.();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
