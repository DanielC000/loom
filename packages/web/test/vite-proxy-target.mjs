// Card 3aba87eb: the dev-proxy target (packages/web/vite.config.ts) used to hardcode the daemon at
// 127.0.0.1:4317, so a LOOM_PORT-overridden daemon (the isolated-daemon-testing workflow CLAUDE.md
// documents) was silently reviewed through the wrong instance while the page rendered perfectly either
// way. This test imports the REAL vite.config.ts (not a re-implementation of its formula) in a child
// process per LOOM_PORT case, and asserts the resolved proxy target — the identity-level check the
// card's DoD calls for, not "did the page load".
//
// Also pins the `||`-not-`??` decision: the daemon's own resolver (packages/daemon/src/paths.ts:206)
// is `Number(process.env.LOOM_PORT || 4317)`, which falls back to 4317 on an empty-string LOOM_PORT.
// vite.config.ts deliberately mirrors that with `||`, not `??` (which would only fall back on
// null/undefined and resolve LOOM_PORT="" to NaN) — a second resolver with different fallback
// semantics would be exactly the kind of divergence this fix exists to avoid.
//
// Run standalone:
//   node --experimental-strip-types packages/web/test/vite-proxy-target.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const webDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function resolvedTarget(loomPort) {
  const env = { ...process.env };
  if (loomPort === undefined) {
    delete env.LOOM_PORT;
  } else {
    env.LOOM_PORT = loomPort;
  }
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--experimental-strip-types",
      "-e",
      "import('./vite.config.ts').then(m => console.log(m.default.server.proxy['/api'].target))",
    ],
    { cwd: webDir, env },
  );
  return stdout.trim();
}

let pass = 0;
const check = async (name, fn) => { await fn(); pass++; console.log(`ok   ${name}`); };

await check("LOOM_PORT unset resolves to the byte-identical default (4317)", async () => {
  assert.equal(await resolvedTarget(undefined), "http://127.0.0.1:4317");
});

await check("LOOM_PORT=5555 (an isolated throwaway daemon) resolves the proxy to that port", async () => {
  assert.equal(await resolvedTarget("5555"), "http://127.0.0.1:5555");
});

await check("LOOM_PORT=\"\" falls back to 4317, matching the daemon's own `||` resolver (not NaN, which `??` would give)", async () => {
  assert.equal(await resolvedTarget(""), "http://127.0.0.1:4317");
});

console.log(`\n${pass} passed`);
