// Run as a child process with LOOM_HOME pointed at the fixture's scratch home, BEFORE the daemon
// boots. Stamps the one-time first-run marker so `maybeAutoLaunchSetup` sees a non-empty install and
// skips auto-launching the Setup Assistant — which would otherwise spawn a REAL claude on daemon boot.
// See the [[loom-isolated-daemon-ui-review]] recipe (Obsidian vault memory) + the E2E Test Suite Design note.
import { Db } from "../../../daemon/dist/db.js";
import { SETUP_FIRST_RUN_KEY } from "../../../daemon/dist/setup/first-run.js";

const db = new Db();
db.setMeta(SETUP_FIRST_RUN_KEY, new Date().toISOString());
