// Run as a child process with LOOM_HOME pointed at a scratch home, BEFORE the daemon boots (same pattern as
// gateway-proxy-seed.mjs, which this is a sibling of). Card f7525818: trusted-proxy mode needs the first-run
// marker (so the Setup Assistant never auto-launches a real claude), the `remoteAccess` platform config from
// LOOM_E2E_REMOTE_ACCESS (JSON), and one gateway token, at BOOT.
//
// It ALSO seeds the project whose vault the spec drives, here rather than over REST, because every write
// route is Tier-0 — unreachable from the proxy origin the spec runs on, which is the whole point of the card.
// `LOOM_E2E_VAULT_PATH` is the on-disk vault dir the spec has already filled with its fixtures.
//
// Card 76227b26: when LOOM_E2E_SEED_QUESTION is set, ALSO stages a manager session + a Request (question)
// carrying one image + one html attachment, for the inbox-attachment-manifest remote-render spec — a
// SEPARATE consumer of this same seed script, same reasoning (the real write path is `question_ask`'s own
// copy step over a session's project roots, which a spec cannot drive from outside the daemon, and every
// REST write is Tier-0 regardless). Writes REAL BYTES into the SAME `questionAttachmentDir` the serving
// route resolves against, mirroring gateway/server.ts's own `/internal/test/seed` questions-attachments
// block (card 19b7cf7a) rather than inventing a second shape for the same contract.
//
// Prints `<gateway token>\t<project id>\t<question id>` on stdout (the third field is empty when
// LOOM_E2E_SEED_QUESTION is unset, so the existing two-field consumer — vault-remote-assets.spec.ts, which
// destructures only the first two — stays byte-identical).
import fs from "node:fs";
import path from "node:path";
import { Db } from "../../../daemon/dist/db.js";
import { questionAttachmentDir } from "../../../daemon/dist/paths.js";
import { deriveAttachmentKind, sanitizeBasename } from "../../../daemon/dist/mcp/attachments.js";
import { SETUP_FIRST_RUN_KEY } from "../../../daemon/dist/setup/first-run.js";

const db = new Db();
db.setMeta(SETUP_FIRST_RUN_KEY, new Date().toISOString());
db.setPlatformConfig({ remoteAccess: JSON.parse(process.env.LOOM_E2E_REMOTE_ACCESS ?? "{}") });

const projectId = "f7525818-vault-remote";
db.insertProject({
  id: projectId,
  name: "Vault remote assets",
  repoPath: process.env.LOOM_E2E_REPO_PATH,
  vaultPath: process.env.LOOM_E2E_VAULT_PATH,
  config: {},
  createdAt: new Date().toISOString(),
  archivedAt: null,
});

const { plaintext } = db.createGatewayToken("e2e-vault-remote");

let questionId = "";
if (process.env.LOOM_E2E_SEED_QUESTION) {
  const agentId = "76227b26-attach-mgr-agent";
  const sessionId = "76227b26-attach-mgr-session";
  const now = new Date().toISOString();
  db.insertAgent({ id: agentId, projectId, name: "AttachMgr", startupPrompt: "", position: 0, profileId: null });
  db.insertSession({
    id: sessionId, projectId, agentId, engineSessionId: null, title: null, cwd: process.env.LOOM_E2E_REPO_PATH,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });

  // A real, small, decodable PNG (a solid square) — `naturalWidth > 0` is only provable against real bytes.
  const PNG_SQUARE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeElEQVR4nO3PUQkAIBTAwNfJtKbVEH4cwmABbrPO/rrhgga0"
    + "oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEAL"
    + "GtCCBrSgAS1oQAseu1+IsaWKj/q+AAAAAElFTkSuQmCC",
    "base64",
  );
  const HTML_MOCKUP = "<!doctype html><html><head><meta charset=\"utf-8\"><title>remote-mockup</title></head>"
    + "<body><h1>remote-mockup</h1></body></html>";

  questionId = "76227b26-0000-4000-8000-000000000001";
  const dir = questionAttachmentDir(questionId);
  fs.mkdirSync(dir, { recursive: true });
  const attachmentInputs = [
    { label: "gate-strip.png", bytes: PNG_SQUARE, imageDimensions: { width: 64, height: 64 } },
    { label: "mockup.html", bytes: Buffer.from(HTML_MOCKUP, "utf8"), imageDimensions: null },
  ];
  const seededAttachments = attachmentInputs.map((a, i) => {
    const storedFilename = `${i}-${sanitizeBasename(a.label)}`;
    fs.writeFileSync(path.join(dir, storedFilename), a.bytes);
    return {
      id: String(i), label: a.label, kind: deriveAttachmentKind(storedFilename),
      sizeBytes: a.bytes.byteLength, imageDimensions: a.imageDimensions, storedFilename,
      originalPath: path.join(dir, storedFilename), openedAt: null,
    };
  });

  db.insertQuestion({
    id: questionId, sessionId, filedBySessionId: sessionId, projectId, type: "decision",
    title: "76227b26-remote-attachments-ask", body: "Remote-render check for inbox attachment previews.",
    options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null, credentialEnvVar: null,
    credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
    provisionConnectionId: null, provisionBindingState: "none", decidedScope: null, decidedExpiresAt: null,
    state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null, attachments: [],
  }, seededAttachments);
}

process.stdout.write(`${plaintext}\t${projectId}\t${questionId}`);
