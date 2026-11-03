// Fixture for test/shadcn-no-dotenv-preload.mjs (card c3f9ce1f). Mimics the ONE call shape shadcn's own
// bundled loadEnvFiles makes against @dotenvx/dotenvx — a destructured named `config` import, called with
// {path, overload, quiet, processEnv} — WITHOUT installing or depending on the real package at all (the
// preload under test redirects the resolution before Node ever needs the real module to exist). Never
// spawns anything itself; always run as a child of the real test under a --import preload.
// Usage: node shadcn-dotenv-import-probe.mjs <envFilePath>
const envFilePath = process.argv[2];
const processEnv = {};
const m = await import("@dotenvx/dotenvx");
const configResult = m.config({ path: envFilePath, overload: false, quiet: true, processEnv });
console.log(JSON.stringify({ exports: Object.keys(m), configResult, processEnvAfter: processEnv }));
