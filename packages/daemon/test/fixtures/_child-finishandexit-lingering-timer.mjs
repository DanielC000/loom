// Proves finishAndExit's whole reason for existing (card 995be21f, directive #8): a file with a
// LINGERING timer (the exact hazard a bare `process.exitCode = N` substitution would hang on, since
// `beforeExit` only fires once the event loop drains NATURALLY, and this interval never lets it). If
// this child does not exit promptly, the parent test's own spawnSync timeout will catch it — proving
// finishAndExit terminates deterministically regardless of what else the file is holding open.
import { mkdtempManaged, finishAndExit } from "../_tmp-fixture.mjs";

const dir = mkdtempManaged("loom-tmpfix-lingering-");
console.log("DIR=" + dir);

// Never resolves/clears on its own — exactly the shape (an open server, an unref'd-but-alive handle, a
// still-running child) that would keep a `process.exitCode`-only file from ever reaching `beforeExit`.
setInterval(() => {}, 1000);

await finishAndExit(0);
