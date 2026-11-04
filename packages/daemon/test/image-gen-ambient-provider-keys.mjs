import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fix round on card b7d6b7f3, ask 2 — mcp-imagenate@0.9.0's `registry.js` registers OpenAI/BFL/Reve from
// ambient env (GPT_IMAGE_API_KEY/OPENAI_API_KEY, BFL_API_KEY, REVE_API_KEY/REVE_API_TOKEN), and 0.9.0 also
// makes an OpenAI key the DEFAULT model preference (`DEFAULT_MODEL_PREFERENCE`). Loom never injects any of
// these (decision `a4058e7a`), but nothing in `packages/daemon/src` scrubs them FROM the daemon's own
// ambient process env either — this file determines, with a REAL spawn (not a mocked exec call), whether
// an ambient key on the host sitting underneath the daemon can reach the `image-gen` MCP child's env.
//
// @decision b7d6b7f3 — never assume this file's green means the fix ADDED this protection: every stdio
// mount, image-gen included, already routes through `assets/env-isolated-launch.mjs` (card
// fafae623/8d26596b, both predating this card) — that's what structurally scrubs the ambient keys below.
//
// Mirrors proxy-env-isolation.mjs / registry-env-isolation.mjs's own real-spawn-through-the-real-launcher
// technique: a fixture-forced "image-gen" row (kind "bundled", pointed at echo-env.mjs) so this is
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE (no real mcp-imagenate install/network resolution needed).
//
// Proves:
//   (a) the image-gen mount's --allow list (the launcher's own entitlement, read off the wrapped mount)
//       carries GEMINI_API_KEY (the real secret) but NONE of the five ambient provider key names.
//   (b) a REAL child_process spawn through the REAL env-isolated-launch.mjs, with all five planted
//       AMBIENT (on the spawning process's own env, exactly where a daemon host's ambient key would sit),
//       shows the real target's env receives GEMINI_API_KEY but NOT ONE of the five ambient keys —
//       checked both by key name AND by a generic sentinel-value sweep (catches a leak under an
//       unexpected key name too, mirroring registry-env-isolation.mjs's own `countKeysWithValue`).
//
// Run: 1) build (turbo builds shared first), 2) node test/image-gen-ambient-provider-keys.mjs
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome, cleanupPathSync } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The five ambient provider keys the card's own triage note named, PLANTED on THIS process's own env
// BEFORE anything is imported — exactly where an ambient key on a real daemon host would sit (the
// launcher's own "inherited env" is this process's env merged with the mount's declared env).
const AMBIENT_SENTINEL = "sk-AMBIENT-SENTINEL-do-not-leak-0000000000000000";
const AMBIENT_PROVIDER_KEYS = ["OPENAI_API_KEY", "GPT_IMAGE_API_KEY", "BFL_API_KEY", "REVE_API_KEY", "REVE_API_TOKEN"];
for (const k of AMBIENT_PROVIDER_KEYS) process.env[k] = AMBIENT_SENTINEL;
// A second, unrelated key carrying the SAME sentinel value — catches a leak under any OTHER key name too
// (mirrors registry-env-isolation.mjs's own generic-sentinel discipline), not just under its own name.
process.env.PROBE_GENERIC_AMBIENT_SENTINEL = AMBIENT_SENTINEL;

const tmpHome = useOwnLoomHome("loom-ig-ambient-keys-");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

const { buildMcpServers } = await import("../dist/pty/host.js");
const { unwrapLauncherMount } = await import("./_env-isolation-helpers.mjs");

const STUB_KEY = "AIzaSTUB-ambient-key-test";
const igRowFixture = {
  id: "cap-ig-ambient", slug: "image-gen", name: "Image Gen (fixture)", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: JSON.stringify(["mcp__image-gen__generate_image"]),
  wantsScratchDir: false, requiresConnection: true, secretEnvVar: "GEMINI_API_KEY", passEnv: [],
  createdAt: new Date().toISOString(),
};

const mcpServers = buildMcpServers({
  sessionId: "s-ig-ambient", port: 4317, role: "worker",
  capabilities: [{ slug: "image-gen", connectionId: "conn-ambient" }],
  capabilityCatalog: [igRowFixture],
  resolveConnectionSecret: () => STUB_KEY,
});
const resolved = mcpServers["image-gen"];
check("(setup) the fixture image-gen row mounted", !!resolved);
const unwrapped = unwrapLauncherMount(resolved);
check("(setup) the mount is routed through the real env-isolating launcher", unwrapped !== null);

// ===================== (a) the computed --allow list (entitlement only, no spawn yet) =====================
check("(a) --allow carries the real secret's own key, GEMINI_API_KEY", unwrapped?.allowKeys.includes("GEMINI_API_KEY"));
for (const k of AMBIENT_PROVIDER_KEYS) {
  check(`(a) --allow does NOT carry the ambient provider key ${k}`, !unwrapped?.allowKeys.includes(k));
}

// ===================== (b) REAL spawn through the REAL launcher, ambient keys actually planted =====================
// `{...process.env, ...resolved.env}` mirrors exactly what claude itself would hand the launcher as ITS
// inherited env (see pty/env-isolation.ts's own doc) — process.env here already carries the five planted
// ambient keys set at the top of this file, so this is the real shape, not a synthetic stand-in for it.
const { stdout } = await execFileAsync(resolved.command, resolved.args, {
  env: { ...process.env, ...resolved.env },
});
const echoed = JSON.parse(stdout);

check("(b) the REAL spawned target received the real secret via GEMINI_API_KEY", echoed.env?.GEMINI_API_KEY === STUB_KEY);
for (const k of AMBIENT_PROVIDER_KEYS) {
  check(`(b) the REAL spawned target's env does NOT contain the ambient provider key ${k}`, !(k in (echoed.env ?? {})));
}
/** How many keys in `env` hold EXACTLY `value` — catches a leak under an unexpected key name. */
const countKeysWithValue = (env, value) => Object.values(env ?? {}).filter((v) => v === value).length;
check("(b) the ambient sentinel value does not leak under ANY key name in the real spawned target's env",
  countKeysWithValue(echoed.env, AMBIENT_SENTINEL) === 0);

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — card b7d6b7f3 fix-round ask 2: five ambient provider keys (OPENAI_API_KEY, GPT_IMAGE_API_KEY, BFL_API_KEY, REVE_API_KEY, REVE_API_TOKEN), planted on the spawning process's own env exactly as they'd sit on a real daemon host, never reach the real image-gen MCP child through the real env-isolated-launch.mjs launcher — by key name AND by generic sentinel-value sweep — while the real GEMINI_API_KEY secret still does. A pre-existing protection (card fafae623/8d26596b), not something this card had to add — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
