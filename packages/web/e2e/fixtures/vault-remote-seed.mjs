// Run as a child process with LOOM_HOME pointed at a scratch home, BEFORE the daemon boots (same pattern as
// gateway-proxy-seed.mjs, which this is a sibling of). Card f7525818: trusted-proxy mode needs the first-run
// marker (so the Setup Assistant never auto-launches a real claude), the `remoteAccess` platform config from
// LOOM_E2E_REMOTE_ACCESS (JSON), and one gateway token, at BOOT.
//
// It ALSO seeds the project whose vault the spec drives, here rather than over REST, because every write
// route is Tier-0 — unreachable from the proxy origin the spec runs on, which is the whole point of the card.
// `LOOM_E2E_VAULT_PATH` is the on-disk vault dir the spec has already filled with its fixtures.
//
// Prints `<gateway token>\t<project id>` on stdout.
import { Db } from "../../../daemon/dist/db.js";
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
process.stdout.write(`${plaintext}\t${projectId}`);
