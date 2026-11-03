// Fixture for test/shadcn-no-dotenv-preload.mjs (card c3f9ce1f) — the narrow-match proof. Imports
// something that is NOT @dotenvx/dotenvx under the SAME --import preload, proving the preload's resolve
// hook is scoped to that one specifier (and its subpaths) and does not block ordinary resolution of
// anything else. Checks BOTH a node: builtin AND a real bare-package specifier (zod, a direct
// @loom/daemon dependency) — a builtin alone would not pin narrowness against a bare package, which
// resolves through node_modules rather than Node's own builtin table.
const m = await import("node:path");
const zodModule = await import("zod");
console.log(JSON.stringify({
  joinIsFunction: typeof m.join === "function",
  zodStringIsFunction: typeof zodModule.z?.string === "function",
}));
