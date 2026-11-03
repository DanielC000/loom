// Loom-owned no-op stand-in for @dotenvx/dotenvx (card c3f9ce1f), loaded ONLY via
// shadcn-no-dotenv-preload.mjs's resolve-redirect — never imported directly, never shipped as a real
// dotenvx replacement for anything else.
//
// shadcn's own bundled `loadEnvFiles` (inside @shadcn/registry) does:
//   let { config: e } = await import("@dotenvx/dotenvx");
//   existsSync(n) && e({ path: n, overload: false, quiet: true, processEnv: o });
// — a named `config` export, called with an options object, its return value UNUSED at this one call
// site (verified by reading the installed shadcn@4.23.0 bundle). This stub still matches real dotenvx's
// actual `config()` return SHAPE on a call that loads nothing (`{ parsed: {} }`) in case any other code
// path ever reads the return value, and it deliberately does nothing else: it never reads `options.path`,
// never touches `options.processEnv`, and never writes to stdout/stderr — the whole reason this redirect
// exists over refusing the import outright is to keep the MCP server's stdout byte-for-byte unaffected
// (no stray non-JSON line before the real JSON-RPC stream starts).
export function config(_options) {
  return { parsed: {} };
}
