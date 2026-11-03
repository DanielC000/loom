// Fixture for test/shadcn-no-dotenv-preload.mjs (card c3f9ce1f) — the narrow-match proof. Imports
// something that is NOT @dotenvx/dotenvx under the SAME --import preload, proving the preload's resolve
// hook is scoped to that one specifier (and its subpaths) and does not block ordinary resolution of
// anything else.
const m = await import("node:path");
console.log(JSON.stringify({ joinIsFunction: typeof m.join === "function" }));
