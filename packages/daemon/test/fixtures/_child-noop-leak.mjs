// RED-first control fixture for tmp-fixture-cleanup.mjs: creates a temp dir WITHOUT the helper (plain
// fs.mkdtempSync, no registration, no cleanup of any kind) and exits normally. Proves the parent test's
// OWN detection method (checking fs.existsSync after this process exits) can see a REAL leak at all —
// a positive control on the test method itself, not on the helper (which this fixture deliberately does
// not use).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tmpfix-controlleak-"));
console.log("DIR=" + dir);
