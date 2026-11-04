import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Fix round on card b7d6b7f3, ask 1 — pin the REAL createPty CALL SITE (pty/host.ts ~:9064:
// `disallowedToolsForSpawn(opts.role, opts.restrictedTools, !!mcpServers.codescape, !!mcpServers.playwright,
// imageGenMountKeys)`), not just the pure `disallowedToolsForSpawn` function in isolation. Card `c1575ee7`
// (Code Review follow-up) replaced the slug-keyed `!!mcpServers["image-gen"]` the call site originally used
// with `capabilityGrantsMountKeysForPackage(...)` — keyed on the resolved `mcp-imagenate` npm package,
// regardless of which slug a row mounts under — and added case (4) below to prove it.
//
// FIX ROUND on card c1575ee7 itself (Code Review): the first cut of this file REPLACED the slug leg
// instead of UNIONING it — `igRowFixture` (cases 1-3) had `package: "mcp-imagenate"` added to its
// provisionJson on top of its existing no-package "bundled" shape, which hid a real coverage regression:
// a SEEDED/re-created "image-gen" row with NO `package` field at all (the actual shape of a `bundled`/
// `command` row an owner can author, or a customized legacy row the migration skipped) got NO disallow
// at all once the call site stopped also checking `mcpServers["image-gen"]`. `igRowFixture` is restored
// below to its ORIGINAL no-package shape, so cases 1/3 (which grant "image-gen") now exercise the SLUG
// LEG specifically, not the package leg. Case 4's fixture is also fixed: a `kind:"bundled"` row carrying
// a `package` field is a row NO OWNER CAN EVER AUTHOR — `validateCapabilityDefInput`'s "bundled" branch
// never accepts or stores a `package` field (only `command`/`args`/`outputDirEnvVar`) — so it modeled an
// impossible state. Case 4 now uses `kind:"node-package"`, the one owner-authorable kind that actually
// carries a `package` field, pointed at a REAL on-disk fixture package via an ABSOLUTE path (the realistic
// owner shape named in the fix round, e.g. "<LOOM_HOME>/node/node_modules/mcp-imagenate" — see
// `capabilityGrantsMountKeysForPackage`'s own basename-matching leg) so `resolveCapabilityServer` actually
// mounts it, same as every other case here.
//
// image-gen-capability.mjs's (disallow)/(e2e-disallow)/(mount-keys) sections already prove the FUNCTIONS
// are correct in isolation (including the exact-specifier and absolute-path-basename matching legs) and
// that a HAND-BUILT buildSpawnArgs call threads the flag — but neither ever executes the real `createPty`
// method body, so a mutant at the call site itself (forcing `imageGenMountKeys` to `[]` unconditionally,
// or dropping just the slug-leg union, keeping every function's own API unchanged) is INVISIBLE to that
// file. This file drives the REAL (unsubclassed) `PtyHost.createPty()` end to end against a fixture CLI
// substituted via `LOOM_CLAUDE_BIN` (mirrors pty-claude-spawn-env.mjs / codex-model-pin-spawn-argv.mjs's
// own `env-dump-cli.mjs` + argv-capture technique) — never the real claude, so no real spawn hazard.
//
// Proves:
//   (1) image-gen GRANTED (role=worker), ORIGINAL no-package fixture shape: the REAL spawn argv carries
//       `mcp__image-gen__generate_video` between `--disallowedTools` and `--strict-mcp-config`, AND the
//       real `--mcp-config` file the same spawn wrote actually mounts an "image-gen" key — so this is
//       proven against what `createPty` itself computed, not a hand-constructed stand-in. Because the
//       fixture carries NO `package` field, this exercises the SLUG-FALLBACK leg specifically: dropping
//       it (a mutant that keeps only the package-matched keys) reddens exactly this case (and case 3).
//   (2) image-gen NOT granted (role=worker): the SAME real spawn path never emits generate_video, and the
//       mcp-config file carries no "image-gen" key — byte-identical-off, proven on the real path too.
//   (3) image-gen GRANTED (role=manager), same no-package fixture: the call site's union is unconditional
//       on role — a manager-role spawn gets the SAME removal (card b7d6b7f3's triage note: "manager/
//       platform get generate_video REMOVED via --disallowedTools"), and (like case 1) exercises the
//       slug-fallback leg.
//   (4) card c1575ee7: an OWNER-AUTHORED `node-package` row under a DIFFERENT slug ("my-video-thing", no
//       "image-gen" row at all), whose `package` field is an ABSOLUTE path to a real fixture package
//       directory ending in "mcp-imagenate" — the slug-keyed check this card replaced could never catch
//       this; the real spawn argv must disallow THIS row's OWN `mcp__my-video-thing__generate_video` tool
//       name. Dropping the package-matched leg (a mutant that keeps only the slug fallback) reddens
//       exactly this case, never cases 1/3.
//
// @decision b7d6b7f3 / c1575ee7 — never drop either leg (slug fallback OR package match) at the call
// site; each catches a real, owner-reachable row shape the other cannot. Never use `negative-control
// --ref <sha>` for this mutant — no real ref carries the current export; hand-edit the literal instead.
//
// WINDOWS-ONLY (`.cmd` wrapper, mirrors pty-claude-spawn-env.mjs's own accepted POSIX gap). SKIPS (exit 0).
//
// Run: 1) build (turbo builds shared first), 2) node test/image-gen-disallow-createpty-chokepoint.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  image-gen-disallow-createpty-chokepoint.mjs — the .cmd-wrapper fixture mechanism is Windows-only (mirrors pty-claude-spawn-env.mjs's own accepted POSIX gap); the pure disallowedToolsForSpawn/buildSpawnArgs builders stay covered by image-gen-capability.mjs on every platform.");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-ig-chokepoint-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_PROJECT_WORK_ROOT;
delete process.env.LOOM_PROJECT_WORK_DIR;
requireHermeticEnv();
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;

const { PtyHost } = await import("../dist/pty/host.js");
const { ensureDirs } = await import("../dist/paths.js");
ensureDirs();

// A fixture image-gen catalog row, resolved via the GENERIC `resolveCapabilityServer` dispatch — "bundled"
// kind pointed at a trivial, never-actually-executed command (we only need resolveCapabilityServer to
// return non-null so the real "image-gen" key appears in createPty's own `mcpServers` map; the resolved
// server is never spawned by this file). FIX ROUND (card c1575ee7 Code Review): this is the row's
// ORIGINAL no-package shape, restored — a `bundled` row's provisionJson never carries a `package` field
// (an owner can never author one; `validateCapabilityDefInput` doesn't accept it for this kind), so
// cases 1/3 below exercise the call site's SLUG-FALLBACK leg (`mcpServers["image-gen"]` truthy), not the
// package-match leg — the leg a prior cut of this fixture (which added `package: "mcp-imagenate"` on top)
// accidentally hid from coverage.
const igRowFixture = {
  id: "cap-ig-chokepoint", slug: "image-gen", name: "Image Gen (fixture)", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["--version"] }),
  toolAllowlistJson: JSON.stringify(["mcp__image-gen__generate_image"]),
  wantsScratchDir: false, requiresConnection: true, secretEnvVar: "GEMINI_API_KEY", passEnv: [],
  createdAt: new Date().toISOString(),
};
// FIX ROUND (card c1575ee7 Code Review): the prior cut of this fixture used `kind:"bundled"` with a
// `package` field — a row shape NO OWNER CAN EVER AUTHOR (`validateCapabilityDefInput`'s "bundled" branch
// never accepts/stores `package`; only `node-package` does). Rebuilt as a real, owner-authorable
// `node-package` row: `package` is an ABSOLUTE path to a REAL on-disk fixture package directory whose
// last segment is "mcp-imagenate" (the realistic shape named in the fix round — e.g. an owner who manually
// installed the npm package under their own LOOM_HOME, e.g. "<LOOM_HOME>/node/node_modules/mcp-imagenate",
// rather than the bare npm specifier) — proving `capabilityGrantsMountKeysForPackage`'s basename-matching
// leg, not just its exact-specifier leg, AND that `resolveNodePackage`'s own `require.resolve` genuinely
// mounts this row (an absolute specifier resolves as a direct file path, no node_modules walk needed), so
// `mcpConfig.mcpServers["my-video-thing"]` below is proven against a REAL resolve, not a stand-in.
const fakeNodePackageDir = path.join(tmpHome, "node", "node_modules", "mcp-imagenate");
fs.mkdirSync(fakeNodePackageDir, { recursive: true });
fs.writeFileSync(path.join(fakeNodePackageDir, "package.json"), JSON.stringify({ name: "mcp-imagenate", version: "0.0.0" }));
const ownerVideoRowFixture = {
  id: "cap-owner-video-chokepoint", slug: "my-video-thing", name: "Owner Video (fixture)", description: "",
  transport: "stdio", kind: "node-package",
  provisionJson: JSON.stringify({ kind: "node-package", package: fakeNodePackageDir, binRelativeToPackageJson: "index.js" }),
  toolAllowlistJson: JSON.stringify(["mcp__my-video-thing__generate_image"]),
  wantsScratchDir: false, requiresConnection: false, secretEnvVar: null, passEnv: [],
  createdAt: new Date().toISOString(),
};
const STUB_KEY = "AIzaSTUB-chokepoint-do-not-leak";

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

function makeHost(catalog) {
  return new PtyHost(events, {
    getCapabilityCatalog: () => catalog,
    resolveConnectionSecret: () => STUB_KEY,
  });
}

/**
 * Drives the REAL createPty() to a real spawned fixture child; returns {argv, mcpConfig}.
 * `withImageGen` is the legacy shape (true ⇒ the real "image-gen" row+grant); `catalog`/`capabilities`
 * (card c1575ee7) let a case mount an OWNER-AUTHORED row under a DIFFERENT slug instead, to prove the
 * package-keyed check fires regardless of which slug resolves to `mcp-imagenate`.
 */
async function spawnAndCapture(sessionId, { role, withImageGen, catalog, capabilities }) {
  const resolvedCatalog = catalog ?? (withImageGen ? [igRowFixture] : []);
  const resolvedCapabilities = capabilities ?? (withImageGen ? [{ slug: "image-gen", connectionId: "conn-ig-chokepoint" }] : []);
  const host = makeHost(resolvedCatalog);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, `cwd-${sessionId}-`));
  const argvOutputFile = path.join(tmpHome, `argv-${sessionId}.json`);
  const envOutputFile = path.join(tmpHome, `env-${sessionId}.json`);
  const opts = {
    sessionId, cwd: spawnCwd, role,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile, FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    capabilities: resolvedCapabilities,
  };
  const pty = host.createPty(opts);
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: `${sessionId} fixture's argv dump file to appear` });
    const argv = JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
    const mcpConfigIdx = argv.indexOf("--mcp-config");
    const mcpConfigValue = mcpConfigIdx !== -1 ? argv[mcpConfigIdx + 1] : null;
    // Card c1575ee7's case (4) row has no secret, so this spawn rides the INLINE-JSON `--mcp-config` form
    // (no file at all) — a shape the (1)-(3) cases never exercised. Try the file form first (existing
    // cases), then fall back to parsing the value directly as inline JSON.
    const mcpConfig = mcpConfigValue && fs.existsSync(mcpConfigValue)
      ? JSON.parse(fs.readFileSync(mcpConfigValue, "utf8"))
      : (mcpConfigValue ? (() => { try { return JSON.parse(mcpConfigValue); } catch { return null; } })() : null);
    return { argv, mcpConfig };
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

function assertDisallowBetweenFlags(argv, label) {
  const d = argv.indexOf("--disallowedTools");
  const strict = argv.indexOf("--strict-mcp-config");
  check(`${label}: --disallowedTools present and precedes --strict-mcp-config`, d !== -1 && strict !== -1 && d < strict);
  const videoIdx = argv.indexOf("mcp__image-gen__generate_video");
  check(`${label}: generate_video (if present) sits between --disallowedTools and --strict-mcp-config`,
    videoIdx === -1 || (videoIdx > d && videoIdx < strict));
}

// ===================== (1) image-gen GRANTED, role=worker =====================
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-worker-on", { role: "worker", withImageGen: true });
  assertDisallowBetweenFlags(argv, "(1 worker+image-gen)");
  check("(1 worker+image-gen) REAL createPty argv includes generate_video in --disallowedTools",
    argv.includes("mcp__image-gen__generate_video"));
  check("(1 worker+image-gen) the REAL mcp-config this spawn wrote actually mounts an 'image-gen' server",
    !!mcpConfig?.mcpServers?.["image-gen"]);
}

// ===================== (2) image-gen NOT granted, role=worker (byte-identical-off on the real path) =====================
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-worker-off", { role: "worker", withImageGen: false });
  assertDisallowBetweenFlags(argv, "(2 worker, no image-gen)");
  check("(2 worker, no image-gen) REAL createPty argv does NOT include generate_video",
    !argv.includes("mcp__image-gen__generate_video"));
  check("(2 worker, no image-gen) the REAL mcp-config carries no 'image-gen' key",
    !mcpConfig?.mcpServers?.["image-gen"]);
}

// ===================== (3) image-gen GRANTED, role=manager — the call site is role-unconditional =====================
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-manager-on", { role: "manager", withImageGen: true });
  assertDisallowBetweenFlags(argv, "(3 manager+image-gen)");
  check("(3 manager+image-gen) REAL createPty argv includes generate_video in --disallowedTools too (role-unconditional union)",
    argv.includes("mcp__image-gen__generate_video"));
  check("(3 manager+image-gen) the REAL mcp-config this spawn wrote actually mounts an 'image-gen' server",
    !!mcpConfig?.mcpServers?.["image-gen"]);
}

// ===================== (4) OWNER-AUTHORED row, DIFFERENT slug, role=worker — card c1575ee7 =====================
// No "image-gen" row/grant at all — only an owner-added "my-video-thing" row whose provision ALSO
// resolves "mcp-imagenate". The slug-keyed `!!mcpServers["image-gen"]` check this card replaced could
// never catch this; the package-keyed check must disallow THIS row's own generate_video tool name.
{
  const { argv, mcpConfig } = await spawnAndCapture("ig-owner-dodge", {
    role: "worker",
    catalog: [ownerVideoRowFixture],
    capabilities: [{ slug: "my-video-thing" }],
  });
  check("(4 owner-authored different-slug mcp-imagenate row) REAL createPty argv disallows THIS row's own generate_video tool name",
    argv.includes("mcp__my-video-thing__generate_video"));
  check("(4 owner-authored different-slug mcp-imagenate row) REAL createPty argv does NOT carry the fixed 'image-gen' legacy tool name (no such row is mounted)",
    !argv.includes("mcp__image-gen__generate_video"));
  check("(4 owner-authored different-slug mcp-imagenate row) the REAL mcp-config this spawn wrote mounts 'my-video-thing', never 'image-gen'",
    !!mcpConfig?.mcpServers?.["my-video-thing"] && !mcpConfig?.mcpServers?.["image-gen"]);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card b7d6b7f3 fix-round ask 1 + card c1575ee7 (incl. its own Code Review fix round): the REAL createPty() call site (pty/host.ts ~:9064) UNIONS the package-matched keys with the literal 'image-gen' slug fallback, threading the result into disallowedToolsForSpawn correctly — proven end to end through a real spawn of a fixture claude substitute (never a hand-built buildSpawnArgs call), for a granted worker spawn with the ORIGINAL no-package fixture shape (exercises the slug-fallback leg), an ungranted worker spawn (byte-identical off), a granted manager spawn with the same no-package shape (role-unconditional, slug-fallback leg again), and a real, owner-authorable `node-package` row under a DIFFERENT slug whose `package` is an ABSOLUTE path to a real fixture package directory (exercises the package-match leg's basename comparison) whose own generate_video tool is disallowed by ITS OWN name — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
