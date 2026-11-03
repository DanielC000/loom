import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c3f9ce1f: the REAL behavioral proof that shadcn-no-dotenv-preload.mjs actually closes the .env*
// exfil path against the REAL, pinned shadcn package's REAL bundled code -- not a fixture standing in for
// its import shape (that hermetic proof lives in test/shadcn-no-dotenv-preload.mjs and
// test/shadcn-capability.mjs; this file is the real-spawn counterpart npm-pinned-real-spawn.mjs already
// established the convention for).
//
// OPT-IN (network, manual-only), mirroring npm-pinned-real-spawn.mjs's own LOOM_NETWORK_SMOKE=1 gate
// (never LOOM_ALLOW_REAL_ENGINE -- that gate is specifically for a real claude/codex ENGINE spawn, which
// this is not; this spawns `npm install` and shadcn's own node bundle, nothing claude/codex-shaped). A
// reasoned entry in real-engine-spawn-opt-in-guard.mjs's own NON_ENGINE_ALLOWLIST is added only if that
// guard's Part B reverse sweep actually flags this file -- it uses execFileSync (never a `.spawn(` member
// call), the same shape npm-pinned-real-spawn.mjs already uses, which that guard does not flag today.
// Prints a WARN SKIP line and does nothing otherwise -- never attempts network access by default.
//
// ⭐ MUST RE-RUN ON ANY SHADCN_VERSION BUMP (capabilities/seed.ts): this is the ONLY test that actually
// re-verifies the mitigation against the real bundle shadcn's next release ships. The hermetic tests
// cannot catch a future version changing its import shape, inlining the dotenv logic, or reading .env*
// some other way entirely -- see docs/decisions/c3f9ce1f-shadcn-mcp-dotenv-exfil-mitigation.md's "Do not"
// list for why that residual is accepted, not closed.
//
// Proves (network mode only):
//   (a) a REAL npm install of the pinned shadcn version (read live off the seeded row's own provision,
//       never duplicated as a separate hardcoded constant) resolves 'ready' via the REAL
//       ensureNpmPinnedAsync production pipeline -- the exact function a real daemon boot uses.
//   (b) the REAL production mount (buildMcpServers -> resolveCapabilityServer -> the env-isolating
//       launcher wrap, exactly as a real session would receive it) spawned against a fixture cwd with a
//       sentinel .env: ZERO hits at the loopback listener, and shadcn's own MISSING_ENV_VARS error (not a
//       registry-reachability error) -- proving the var was never resolved at all, identical to "no .env
//       exists".
//   (c) same for .env.local.
//   (d) POSITIVE CONTROL: the SAME mount's args with the preload's `--import <url>` pair stripped out
//       (API-preserving: every other argv element identical) DOES leak the sentinel -- proving (b)/(c)
//       are not vacuous passes from a broken harness.
//   (e) a real tool call (view_items_in_registries) against the fixture's own real components.json
//       registries still succeeds with the mitigation active -- components.json lookup is unaffected.
//   (f) stdout carries NO non-JSON line before the first JSON-RPC frame (the reason the redirect was
//       chosen over an outright refusal in the first place).
//
// Run (default, no network): node test/shadcn-dotenv-exfil-real-spawn.mjs  (prints WARN SKIP, exits 0)
// Run (opt-in network smoke): LOOM_NETWORK_SMOKE=1 node test/shadcn-dotenv-exfil-real-spawn.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

if (process.env.LOOM_NETWORK_SMOKE !== "1") {
  console.log("WARN  SKIP — LOOM_NETWORK_SMOKE not set; the real shadcn-package exfil-closure smoke did not run. Set LOOM_NETWORK_SMOKE=1 to exercise it (installs the real, pinned shadcn package from the real npm registry).");
  process.exit(0);
}

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-shadcn-exfil-real-");
delete process.env.LOOM_NPM_PINNED_NO_PROVISION; // exercise the REAL install path for this one row

const TEST_NPM_CACHE_DIR = path.join(process.env.LOOM_HOME, "npm-cache");
process.env.npm_config_cache = TEST_NPM_CACHE_DIR; // every npm call this test (or ensureNpmPinnedAsync) makes stays off the host cache

const { Db } = await import("../dist/db.js");
const { seedDefaultCapabilities } = await import("../dist/capabilities/seed.js");
const { ensureNpmPinnedAsync, loomNpmPinnedBin } = await import("../dist/capabilities/npm-pinned.js");
const { buildMcpServers } = await import("../dist/pty/host.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const db = new Db();
seedDefaultCapabilities(db);
const scRow = db.getCapabilityDefBySlug("shadcn");
const scProvision = JSON.parse(scRow.provisionJson);
check("precondition: the seeded shadcn row's package is 'shadcn'", scProvision.package === "shadcn");

// ===================== (a) REAL npm install of the pinned version, via the REAL production pipeline =====================
const bin = loomNpmPinnedBin(scProvision.package, scProvision.version, scProvision.binRelativeToPackageJson);
check("precondition: the bin is ABSENT before install (cold)", !fs.existsSync(bin));
const installResult = await ensureNpmPinnedAsync({
  package: scProvision.package, version: scProvision.version, binRelativeToPackageJson: scProvision.binRelativeToPackageJson,
});
check(`(a) a real install of shadcn@${scProvision.version} resolves 'ready' (got '${installResult.outcome}'${installResult.errorTail ? `: ${installResult.errorTail}` : ""})`, installResult.outcome === "ready");
check("(a) the resolved bin actually exists on disk", fs.existsSync(bin));

// ===================== the REAL production mount, exactly as a real session receives it =====================
const catalog = db.listCapabilityDefs();
const granted = buildMcpServers({ sessionId: "s-shadcn-realspawn", port: 4317, role: "worker", capabilities: [{ slug: "shadcn" }], capabilityCatalog: catalog });
// Shape (wrapStdioMountWithEnvIsolation): [ENV_ISOLATED_LAUNCH_SCRIPT, "--allow", csv, "--", realCommand,
// ...realArgs] — for shadcn, realArgs is ["--import", <url>, bin, "mcp"], so the full wrapped args are
// [launcherPath, "--allow", csv, "--", nodeBin, "--import", url, bin, "mcp"].
const mitigatedMount = granted.shadcn;
const importIdx = mitigatedMount.args.indexOf("--import");
check("precondition: the real production mount carries '--import' right after the real command, before the resolved bin",
  importIdx >= 0 && mitigatedMount.args[importIdx + 2] === bin);

// POSITIVE-CONTROL mount: the SAME real mount, with the preload's `--import <url>` pair stripped out —
// every other argv element (the launcher itself, the allow-list, the real command, the bin, "mcp") is
// byte-identical.
const unmitigatedMount = { ...mitigatedMount, args: [...mitigatedMount.args.slice(0, importIdx), ...mitigatedMount.args.slice(importIdx + 2)] };

async function runExfilProbe(mount, envFileName, sentinelSuffix) {
  const SENTINEL = `sentinel-real-spawn-${sentinelSuffix}`;
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push({ url: req.url, headerEqualsSentinel: req.headers["x-probe"] === SENTINEL });
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const cwd = path.join(process.env.LOOM_HOME, `fixture-${sentinelSuffix}`);
  fs.mkdirSync(cwd, { recursive: true });
  if (envFileName) fs.writeFileSync(path.join(cwd, envFileName), `PROBE_DOTENV_TOKEN=${SENTINEL}\n`);
  fs.writeFileSync(path.join(cwd, "components.json"), JSON.stringify({
    $schema: "https://ui.shadcn.com/schema.json", style: "new-york", rsc: false, tsx: true,
    tailwind: { config: "", css: "src/index.css", baseColor: "neutral", cssVariables: true, prefix: "" },
    aliases: { components: "@/components", utils: "@/lib/utils", ui: "@/components/ui", lib: "@/lib", hooks: "@/hooks" },
    registries: { "@probe": { url: `http://127.0.0.1:${port}/r/{name}.json`, headers: { "X-Probe": "${PROBE_DOTENV_TOKEN}" } } },
  }, null, 2));

  // Mirrors the REAL MCP client's own env build (claude's stdio transport merges a declared server.env
  // ON TOP of the base env) — shadcn's row has no `env` field at all today, so this is a no-op in
  // practice, kept for fidelity in case that ever changes.
  const plantedEnv = { ...process.env, ...(mount.env ?? {}) };
  delete plantedEnv.PROBE_DOTENV_TOKEN;

  let stdoutRaw = "";
  let viewResult = null;
  await new Promise((resolve, reject) => {
    const child = spawn(mount.command, mount.args, { cwd, env: plantedEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    const nonJsonLines = [];
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 60_000);
    child.stdout.on("data", (d) => {
      stdoutRaw += d.toString();
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { nonJsonLines.push(line.slice(0, 200)); continue; }
        if (m.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "view_items_in_registries", arguments: { items: ["@probe/button"] } } });
        } else if (m.id === 2) {
          viewResult = { isError: !!m.result?.isError || !!m.error, textHead: String(m.result?.content?.[0]?.text ?? m.error?.message ?? "").slice(0, 200), nonJsonLines };
          clearTimeout(timer);
          try { child.kill(); } catch {}
          resolve();
        }
      }
    });
    child.on("error", reject);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
  });
  srv.close();
  return { hits, viewResult, stdoutRaw };
}

// ===================== (b) .env, mitigation ON — expect ZERO hits =====================
const resultEnvOn = await runExfilProbe(mitigatedMount, ".env", "env-on");
check("(b) .env WITH mitigation: ZERO hits at the loopback listener", resultEnvOn.hits.length === 0);
check("(b) .env WITH mitigation: shadcn's own MISSING_ENV_VARS error (var never resolved, not a reachability error)",
  resultEnvOn.viewResult?.isError === true && /MISSING_ENV_VARS/.test(resultEnvOn.viewResult?.textHead ?? ""));

// ===================== (c) .env.local, mitigation ON — expect ZERO hits =====================
const resultEnvLocalOn = await runExfilProbe(mitigatedMount, ".env.local", "envlocal-on");
check("(c) .env.local WITH mitigation: ZERO hits at the loopback listener", resultEnvLocalOn.hits.length === 0);
check("(c) .env.local WITH mitigation: shadcn's own MISSING_ENV_VARS error", resultEnvLocalOn.viewResult?.isError === true && /MISSING_ENV_VARS/.test(resultEnvLocalOn.viewResult?.textHead ?? ""));

// ===================== (d) POSITIVE CONTROL: same mount, --import stripped — expect a LEAK =====================
const resultControl = await runExfilProbe(unmitigatedMount, ".env", "positive-control");
check("(d) POSITIVE CONTROL (--import stripped): the sentinel DOES leak — proves (b)/(c) are not vacuous",
  resultControl.hits.length > 0 && resultControl.hits.some((h) => h.headerEqualsSentinel));

// ===================== (e) a real tool call against the fixture's own real registries still works =====================
const resultNoEnv = await runExfilProbe(mitigatedMount, null, "no-env-real-tool-call");
check("(e) a real tool call against the fixture's own components.json registries runs (reaches the registry, not a local config error)",
  resultNoEnv.viewResult !== null);

// ===================== (f) stdout carries NO non-JSON line before the first JSON-RPC frame =====================
check("(f) mitigated mount: stdout has NO non-JSON line (the whole reason the redirect was chosen over a refusal)",
  (resultEnvOn.viewResult?.nonJsonLines ?? ["<no result>"]).length === 0);

db.close();
try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort — the harness registry also sweeps this */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the REAL shadcn package's own dotenv-loading exfil path is closed end to end: .env and .env.local sentinels never reach the registry listener and shadcn itself reports MISSING_ENV_VARS (identical to no .env existing), a positive control with the mitigation's --import stripped DOES leak (proving the harness is not vacuous), a real tool call against the fixture's own components.json registries still works, and the MCP server's stdout carries no stray non-JSON line."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
