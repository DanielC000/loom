import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c3f9ce1f: the shadcn-no-dotenv-preload.mjs / shadcn-no-dotenv-stub.mjs mechanism itself — a `node
// --import` preload that redirects any resolution of @dotenvx/dotenvx (or a subpath) to a Loom-owned
// no-op stub, so shadcn's own bundled `loadEnvFiles` never reads `.env*` files out of the MCP server's
// cwd into process.env. See docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md for the full
// investigation (why a REDIRECT was chosen over an outright refusal: a refusal still runs shadcn's own
// `console.log` warning, a stray non-JSON line on the MCP server's stdout before any JSON-RPC traffic).
//
// HERMETIC: no real shadcn, no real @dotenvx/dotenvx, no network, no claude. The fixtures under
// test/fixtures/ mimic the ONE call shape shadcn's bundle actually makes (a destructured named `config`
// import, called with {path, overload, quiet, processEnv}) without installing or needing the real
// package at all — the preload redirects the resolution before Node ever looks for it on disk.
//
// The ROW-LEVEL wiring (resolveCapabilityServer prepending ["--import", <this preload's file:// URL>] to
// the shadcn row's own resolved args, scoped to provision.package==="shadcn" only, image-gen staying
// byte-identical) is proved in test/shadcn-capability.mjs's (c) section, not duplicated here.
//
// Proves:
//   (a) a REAL node --import spawn of this preload against the import-shape fixture: the fixture's
//       `await import("@dotenvx/dotenvx")` resolves to OUR stub, not any real package — its export set is
//       EXACTLY {config}, never the real dotenvx's much larger export set (bold/config/default/doctor/
//       genexample/get/getColor/keypair/logger/ls/parse/set/setLogLevel — confirmed by reading the real
//       installed @dotenvx/dotenvx@1.75.1 module during this card's investigation).
//   (b) the stub's config() is a true no-op even against a REAL, EXISTING env file with a real key: the
//       `processEnv` object passed in is left completely untouched (never mutated), and the return value
//       matches the real library's own shape on a load-nothing call ({parsed:{}}) — proving this isn't
//       merely "doesn't crash" but genuinely never reads the file's content into anything the caller can
//       observe.
//   (c) the SAME preload, with DIFFERENT imports (a node:path builtin AND a bare-package specifier, zod
//       — never @dotenvx/dotenvx) still resolves completely normally — the hook is narrowly scoped to one
//       specifier (+ subpaths), not a blanket import-blocker, and that scoping holds for a package that
//       resolves through node_modules too, not just Node's own builtin table.
//   (d) a subpath of @dotenvx/dotenvx (e.g. "@dotenvx/dotenvx/config") is ALSO redirected, not just the
//       bare specifier.
//   (e) card 2e02dc38: a CJS `require("@dotenvx/dotenvx")` (via createRequire) under the SAME preload is
//       ALSO redirected to the stub — proving the `module.registerHooks` adoption actually closes the
//       CJS gap a `module.register`-only hook leaves open (see
//       docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md's "Do not assume version-proof"
//       bullet). Only meaningful on a Node >=22.15 that actually has `registerHooks` — see the RED proof
//       below for what happens on the pre-22.15 fallback.
//
// Both RED proofs (the original c3f9ce1f redirect-disabled mutant, and the 2e02dc38
// registerHooks-disabled mutant) were run by hand during development, not re-run by this file — see
// docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md's "RED-proof narratives" section for the
// exact mutations and what each one crashed with.
//
// Run: 1) build, 2) node test/shadcn-no-dotenv-preload.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-shadcn-nodotenv-");

const { SHADCN_NO_DOTENV_PRELOAD_SCRIPT } = await import("../dist/paths.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_PROBE_FIXTURE = path.join(__dirname, "fixtures", "shadcn-dotenv-import-probe.mjs");
const OTHER_IMPORT_FIXTURE = path.join(__dirname, "fixtures", "other-import-probe.mjs");
const REQUIRE_PROBE_FIXTURE = path.join(__dirname, "fixtures", "shadcn-dotenv-require-probe.mjs");
const PRELOAD_URL = pathToFileURL(SHADCN_NO_DOTENV_PRELOAD_SCRIPT).href;

// A REAL, existing env file with a real, distinctive key — if the stub were ever bypassed and the real
// dotenvx loaded it, this exact key would show up in processEnvAfter. It never should.
const fixtureEnvDir = path.join(tmpHome, "dotenv-fixture-cwd");
fs.mkdirSync(fixtureEnvDir, { recursive: true });
const fixtureEnvPath = path.join(fixtureEnvDir, ".env");
fs.writeFileSync(fixtureEnvPath, "SHADCN_NO_DOTENV_PRELOAD_CANARY=should-never-load\n");

// ===================== (a)+(b) the import-shape fixture under the REAL preload =====================
const { stdout: probeOut } = await execFileAsync(process.execPath, ["--import", PRELOAD_URL, IMPORT_PROBE_FIXTURE, fixtureEnvPath]);
const probeResult = JSON.parse(probeOut);

check("(a) @dotenvx/dotenvx resolves to OUR stub (export set is exactly {config}, not real dotenvx's larger set)",
  JSON.stringify(probeResult.exports) === JSON.stringify(["config"]));
check("(b) the stub's config() return value matches real dotenvx's own load-nothing shape: {parsed:{}}",
  JSON.stringify(probeResult.configResult) === JSON.stringify({ parsed: {} }));
check("(b) processEnv passed to config() is left COMPLETELY untouched — the real file's canary key never appears",
  JSON.stringify(probeResult.processEnvAfter) === JSON.stringify({}));

// ===================== (c) narrow-match: a DIFFERENT import still resolves normally =====================
const { stdout: otherOut } = await execFileAsync(process.execPath, ["--import", PRELOAD_URL, OTHER_IMPORT_FIXTURE]);
const otherResult = JSON.parse(otherOut);
check("(c) an import of something else entirely (node:path) under the SAME preload still resolves normally",
  otherResult.joinIsFunction === true);
check("(c) a bare-package specifier (zod, not just a node: builtin) under the SAME preload also resolves normally",
  otherResult.zodStringIsFunction === true);

// ===================== (d) a subpath of @dotenvx/dotenvx is ALSO redirected =====================
const subpathProbeScript = path.join(tmpHome, "subpath-probe.mjs");
fs.writeFileSync(subpathProbeScript,
  'const m = await import("@dotenvx/dotenvx/config");\nconsole.log(JSON.stringify({exports: Object.keys(m)}));\n');
const { stdout: subpathOut } = await execFileAsync(process.execPath, ["--import", PRELOAD_URL, subpathProbeScript]);
const subpathResult = JSON.parse(subpathOut);
check("(d) a subpath (@dotenvx/dotenvx/config) is ALSO redirected to the stub, not just the bare specifier",
  JSON.stringify(subpathResult.exports) === JSON.stringify(["config"]));

// ===================== (e) a CJS require() of @dotenvx/dotenvx is ALSO redirected (card 2e02dc38) =====================
const { stdout: requireOut } = await execFileAsync(process.execPath, ["--import", PRELOAD_URL, REQUIRE_PROBE_FIXTURE]);
const requireResult = JSON.parse(requireOut);
check("(e) a createRequire-based CJS require() of @dotenvx/dotenvx is ALSO redirected to the stub (export set is exactly {config}) — proves the registerHooks adoption closes the CJS gap a register()-only hook leaves open",
  JSON.stringify(requireResult.exports) === JSON.stringify(["config"]));

console.log(failures === 0
  ? "\n✅ ALL PASS — shadcn-no-dotenv-preload.mjs (card c3f9ce1f, card 2e02dc38): the --import preload redirects @dotenvx/dotenvx (bare specifier, a subpath, AND a CJS require()) to a Loom-owned no-op stub whose config() genuinely never mutates the caller's processEnv even against a real, existing env file with a real key, the stub's return shape matches real dotenvx's own load-nothing shape, and an unrelated import under the SAME preload is completely unaffected — hermetic, no real shadcn/dotenvx package, no network."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
