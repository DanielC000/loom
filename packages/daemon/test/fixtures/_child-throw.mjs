// Uncaught-throw fixture — closes the "no cleanup on the FAILURE path" leak shape (worktrees-base-
// isolation.mjs and 25/88 companion-*.mjs files had no cleanup at all; several others only clean up on
// a path that assumes every earlier assertion succeeded). `beforeExit` does not fire for this shape
// either; the SYNC `exit` backstop must run even though the process is terminating via an unhandled
// exception, not a clean return.
import { mkdtempManaged } from "../_tmp-fixture.mjs";

const dir = mkdtempManaged("loom-tmpfix-throw-");
console.log("DIR=" + dir);
throw new Error("simulated uncaught failure — proving cleanup still runs on the failure path");
