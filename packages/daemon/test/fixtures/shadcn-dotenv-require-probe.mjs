// Fixture for test/shadcn-no-dotenv-preload.mjs (card 2e02dc38, follow-up to c3f9ce1f) — the CJS
// require() coverage proof. Uses createRequire to require() @dotenvx/dotenvx the way a FUTURE shadcn
// release might if it ever switched from a dynamic import() to a CJS require() of this package (the gap
// named in the decision record's "Do not assume version-proof" bullet). Never spawns anything itself;
// always run as a child of the real test under a --import preload.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const m = require("@dotenvx/dotenvx");
console.log(JSON.stringify({ exports: Object.keys(m) }));
