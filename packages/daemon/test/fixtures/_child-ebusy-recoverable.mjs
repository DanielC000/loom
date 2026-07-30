// EBUSY POSITIVE CONTROL (recoverable case) — card 995be21f DoD#3, the acceptance evidence the manager
// asked for by name: keep a REAL process alive with its CWD inside a managed dir (verified empirically
// on this host/Node to throw EBUSY on rmdir — a plain open file handle does NOT, since this Node/Windows
// combo opens files with FILE_SHARE_DELETE by default, so `rmSync` on a dir with an open-but-shared file
// inside quietly succeeds; a live process's CWD is what actually reproduces the lock. This is also the
// FAITHFUL real-world shape: dev-server-teardown.mjs's exact scenario — a killed/orphaned child process
// whose CWD sat inside the directory being torn down). Prove the helper's cleanup absorbs the resulting
// EBUSY without throwing, and that THIS process's own already-passed assertion is unaffected by it
// (never overridden to a non-zero exit by a throw in cleanup).
//
// The holder manages its OWN lifetime independently (an internal setTimeout, not something this process
// kills) — this process's own `exit` handler blocks the whole thread via a synchronous Atomics.wait
// between retry attempts (see _tmp-fixture.mjs CORRECTION 1), so nothing scheduled in THIS process would
// get a chance to run while that block is in progress; a separate process's own event loop is unaffected
// by this process being CPU-blocked.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { mkdtempManaged } from "../_tmp-fixture.mjs";

const dir = mkdtempManaged("loom-tmpfix-ebusy-recoverable-");
console.log("DIR=" + dir);

// Alive for 300ms with CWD inside `dir`, then exits on its own — well inside this process's own retry
// budget (5 attempts x 100ms delay = ~400ms of blocking after the first attempt), so the CWD lock clears
// in time for a later attempt to succeed.
const holder = spawn(process.execPath, ["-e", `
  process.stdout.write("READY\\n");
  setTimeout(() => process.exit(0), 300);
`], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });

await new Promise((resolve) => {
  holder.stdout.on("data", (d) => { if (d.toString().includes("READY")) resolve(); });
});

// This is the "already-passed test" this whole scenario protects — a real assertion that succeeds
// BEFORE we ever touch the EBUSY path below.
const assertionPassed = fs.existsSync(dir);
console.log("CHECK_PASSED=" + assertionPassed);

// Trigger cleanup while the holder's CWD is still inside `dir` (we've only just confirmed READY, so the
// full ~300ms window is still ahead). Explicit exit() -> exercises the SYNC backstop, not beforeExit.
process.exit(assertionPassed ? 0 : 1);
