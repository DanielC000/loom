// Card 4eb6cbc0: `finishAndExit` with an EMPTY cleanup registry — no `mkdtempManaged()`/
// `registerForCleanup()` call anywhere — is the exact gap the investigation found: the registry's `for`
// loop runs zero iterations, so (pre-fix) `process.exit()` fired exactly as synchronously as every
// bare-`process.exit` test file, none of the incidental protection the other ~89 `finishAndExit` callers
// got as a side effect of their own async cleanup. Prints a large, distinctive payload immediately before
// calling `finishAndExit` with nothing registered, so the parent test can assert every line survived.
import { finishAndExit } from "../_tmp-fixture.mjs";

const MARKER = process.env.LOOM_TEST_MARKER ?? "DEFAULTMARKER";
const LINE_COUNT = Number(process.env.LOOM_TEST_LINE_COUNT ?? 2000);

for (let i = 0; i < LINE_COUNT; i++) {
  console.log(`${MARKER}-LINE-${i}`);
}

await finishAndExit(0);
