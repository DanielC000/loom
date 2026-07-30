// Explicit process.exit(1) fixture — today's universal end-of-file pattern in this suite
// (`process.exit(failures === 0 ? 0 : 1)`). `beforeExit` never fires for this shape; only the SYNC
// `exit` backstop can clean up here.
import { mkdtempManaged } from "../_tmp-fixture.mjs";

const dir = mkdtempManaged("loom-tmpfix-exit1-");
console.log("DIR=" + dir);
process.exit(1);
