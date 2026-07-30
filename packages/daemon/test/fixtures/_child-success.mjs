// Success-path fixture: creates a managed dir and ends WITHOUT calling process.exit() explicitly (sets
// exitCode instead), so Node drains its event loop naturally and the PRIMARY `beforeExit` cleanup path
// fires (not just the sync `exit` backstop).
import { mkdtempManaged } from "../_tmp-fixture.mjs";

const dir = mkdtempManaged("loom-tmpfix-success-");
console.log("DIR=" + dir);
process.exitCode = 0;
