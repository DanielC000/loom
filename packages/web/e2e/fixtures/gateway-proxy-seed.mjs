// Run as a child process with LOOM_HOME pointed at a scratch home, BEFORE the daemon boots (same pattern as
// prestamp.mjs). Card 4cbbc343: seeds what trusted-proxy mode needs at BOOT — the first-run marker (so the Setup
// Assistant never auto-launches a real claude), the `remoteAccess` platform config from LOOM_E2E_REMOTE_ACCESS
// (JSON), and one gateway token (proxy mode refuses to open without one) whose plaintext is printed to stdout.
import { Db } from "../../../daemon/dist/db.js";
import { SETUP_FIRST_RUN_KEY } from "../../../daemon/dist/setup/first-run.js";

const db = new Db();
db.setMeta(SETUP_FIRST_RUN_KEY, new Date().toISOString());
db.setPlatformConfig({ remoteAccess: JSON.parse(process.env.LOOM_E2E_REMOTE_ACCESS ?? "{}") });
const { plaintext } = db.createGatewayToken("e2e-proxy");
process.stdout.write(plaintext);
