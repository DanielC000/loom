// Loom-owned `node --import` preload for the shadcn MCP mount only. Registers a module customization
// hook (self-registering: `register(import.meta.url, import.meta.url)`) that REDIRECTS any resolution of
// `@dotenvx/dotenvx` (or a subpath) to the sibling no-op stub (shadcn-no-dotenv-stub.mjs), never the real
// package. Scoped to the shadcn mount alone (registry.ts prepends `--import <this file's URL>` to that
// row's own resolved args) — no other stdio mount's argv is touched, and the launcher needs no change: it
// already forwards whatever argv a mount hands it.
//
// @decision c3f9ce1f — never swap this redirect for an outright refusal of the import: a refused import
// still runs shadcn's own catch block, which logs via `console.log` (not `console.error`), putting a
// stray non-JSON line on the MCP server's stdout before any JSON-RPC traffic.
import { register } from "node:module";

const STUB_URL = new URL("./shadcn-no-dotenv-stub.mjs", import.meta.url).href;

register(import.meta.url, import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@dotenvx/dotenvx" || specifier.startsWith("@dotenvx/dotenvx/")) {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
