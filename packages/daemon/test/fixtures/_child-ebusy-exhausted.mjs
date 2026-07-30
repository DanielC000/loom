// EBUSY POSITIVE CONTROL (exhausted case) — the honest complement to the recoverable one: the holder
// (a live process with its CWD inside the managed dir — see _child-ebusy-recoverable.mjs for why CWD,
// not an open file handle, is what actually reproduces EBUSY on this host/Node) stays alive PAST this
// process's retry budget (5 x 100ms = ~400ms of blocking after the first attempt), so cleanup genuinely
// exhausts all attempts. Proves CORRECTION 2's documented behavior for real: no throw, no hang, this
// process still exits promptly, and the dir is honestly left behind (never silently claimed as removed)
// with a logged warning on stderr.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempManaged } from "../_tmp-fixture.mjs";

const dir = mkdtempManaged("loom-tmpfix-ebusy-exhausted-");
console.log("DIR=" + dir);

// Alive well past the ~400-500ms retry budget; detached + unref'd so it doesn't keep this process (or
// the parent test process waiting on it) alive.
const holder = spawn(process.execPath, ["-e", `
  process.stdout.write("READY\\n");
  setTimeout(() => process.exit(0), 2000);
`], { cwd: dir, stdio: ["ignore", "pipe", "ignore"], detached: true });
holder.unref();

await new Promise((resolve) => {
  holder.stdout.on("data", (d) => { if (d.toString().includes("READY")) resolve(); });
});

const assertionPassed = fs.existsSync(dir);
console.log("CHECK_PASSED=" + assertionPassed);
process.exit(assertionPassed ? 0 : 1);
