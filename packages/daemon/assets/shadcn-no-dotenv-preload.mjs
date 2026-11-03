// Loom-owned `node --import` preload for the shadcn MCP mount only. REDIRECTS any resolution of
// `@dotenvx/dotenvx` (or a subpath) to the sibling no-op stub (shadcn-no-dotenv-stub.mjs), never the real
// package. Scoped to the shadcn mount alone (registry.ts prepends `--import <this file's URL>` to that
// row's own resolved args) — no other stdio mount's argv is touched, and the launcher needs no change: it
// already forwards whatever argv a mount hands it.
//
// @decision c3f9ce1f — never swap this redirect for an outright refusal of the import: a refused import
// still runs shadcn's own catch block, which logs via `console.log` (not `console.error`), putting a
// stray non-JSON line on the MCP server's stdout before any JSON-RPC traffic.
//
// @decision c3f9ce1f — prefers `registerHooks` (covers CJS `require` too) over `register` (ESM-loader
// only) when available, falling back to `register` on a pre-22.15 Node. See the decision record's "Do
// not assume version-proof" bullet for why the fallback still leaves a CJS gap.
import { register, registerHooks } from "node:module";

const STUB_URL = new URL("./shadcn-no-dotenv-stub.mjs", import.meta.url).href;

// Deliberately NOT `async` — `registerHooks` requires a synchronous hook (an async one throws
// ERR_INVALID_RETURN_PROPERTY_VALUE, measured). The same plain function also satisfies `register`'s
// async-hook protocol on the fallback path below: `nextResolve` there returns a Promise, and simply
// returning it (without awaiting) is exactly what an `async` wrapper would have done anyway.
function resolve(specifier, context, nextResolve) {
  if (specifier === "@dotenvx/dotenvx" || specifier.startsWith("@dotenvx/dotenvx/")) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

if (typeof registerHooks === "function") {
  registerHooks({ resolve });
} else {
  register(import.meta.url, import.meta.url);
}

export { resolve };
