import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 188d6a8c: HTTP_PROXY/HTTPS_PROXY/ALL_PROXY (a proxy URL may carry `user:pass@host:port`
// credentials) are no longer in env-isolated-launch.mjs's unconditional BASE_ALLOWLIST (see that file's
// own test for the base-allowlist-level proof). Card c6da31e9: NO_PROXY/no_proxy joined them — no
// credential, but topology (internal hostnames) and useless without a forwarded proxy var, so a
// ${VAR}-expanding mount with no proxy entitlement at all has no business receiving it either. This file
// proves `buildMcpServers`' (pty/host.ts) own per-mount ENTITLEMENT decision: which mounts get
// PROXY_ENV_KEYS added to their `--allow` list, and that the decision is keyed safely (never on a mutable
// `slug`/`name` an owner could collide with).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: LOOM_MARKITDOWN_BIN/LOOM_GITHUB_MCP_BIN point at
// process.execPath so neither resolver needs a real install.
//
// Proves:
//   (a) markitdown's mount gets PROXY_ENV_KEYS unconditionally (it's not a catalog row, so this is a
//       fixed addition, not a passEnv opt-in).
//   (b) the SEEDED github-binary capability (kind:"github-binary") gets PROXY_ENV_KEYS too.
//   (c) an owner-added capability whose `slug` happens to equal "github" but whose `kind` is NOT
//       "github-binary" does NOT get PROXY_ENV_KEYS — the entitlement is keyed on `kind` (a value
//       validateCapabilityDefInput structurally refuses from any owner input), never on `slug`/`name`.
//   (d) an ordinary owner-added capability with NO passEnv gets no proxy keys either (the default,
//       unaffected by this card).
//   (e) a REAL child_process spawn proves an owner-added row's own explicit `passEnv:["HTTPS_PROXY"]`
//       still reaches the real target with the credentialed value — the existing opt-in mechanism,
//       unaffected by this card's scoping of the base allowlist.
//   (f) card d2fece1f: a browserTesting:true session's Playwright mount gets NONE of PROXY_ENV_KEYS —
//       confirmed (see the fafae623 record's own "Proxy credentials" section) Playwright doesn't read
//       them at all, and the browserTesting grant path never reaches the per-mount passEnvByMountKey
//       loop in the first place (it `continue`s before that loop).
//   (g) card d2fece1f: the seeded image-gen capability (kind:"npm-pinned") gets NONE of PROXY_ENV_KEYS —
//       the fixed entitlement is keyed on `def.kind === "github-binary"` only, and npm-pinned is not that
//       kind, so it falls through to the same "no fixed entitlement" path as any other owner-added row.
//   (i) card c6da31e9 review fix: a row whose own passEnv names ONLY a credentialed proxy var (e.g.
//       passEnv:["HTTPS_PROXY"]) gets NO_PROXY/no_proxy auto-paired into its --allow list too, proven both
//       in the allow-list computation and via a real spawn; a row naming no proxy key still gets neither.
//
// What this file does NOT cover (by construction, not oversight): a real end-to-end spawn of markitdown's
// or github-binary's OWN resolved mount with a credentialed proxy value actually reaching the process.
// Both resolve to a fixed executable with FIXED args (markitdown: `args:[]`; github-binary: hardcoded
// `args:["stdio"]`), so neither can be redirected to an env-dumping fixture through its OWN production
// resolution path without replacing that fixed shape (which this card doesn't touch). The GENERIC
// raw-value-forwarding mechanism is already proven real-spawn end to end by
// env-isolated-launch.mjs's (c2) and capability-pass-env.mjs's (d); this file's (e) extends that same
// proven mechanism to a proxy-shaped key name, and (a)/(b)/(c)/(d) prove the ALLOW-LIST computation
// (pty/host.ts's `passEnvByMountKey`) that feeds it is correct for the two entitled built-in mounts.
//
// Run: 1) build (turbo builds shared first), 2) node test/proxy-env-isolation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome, cleanupPathSync } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-proxy-env-iso-");
// HUMAN-only override seams (mirror LOOM_CLAUDE_BIN) — point both at a real absolute path so neither
// resolver needs a real markitdown/github-mcp-server install. Set BEFORE importing dist.
process.env.LOOM_MARKITDOWN_BIN = process.execPath;
process.env.LOOM_GITHUB_MCP_BIN = process.execPath;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

const { buildMcpServers, PROXY_ENV_KEYS } = await import("../dist/pty/host.js");
const { unwrapLauncherMount } = await import("./_env-isolation-helpers.mjs");

check("(setup) PROXY_ENV_KEYS names the six proxy/topology keys scoped out of BASE_ALLOWLIST (cards 188d6a8c, c6da31e9)",
  JSON.stringify([...PROXY_ENV_KEYS].sort()) === JSON.stringify(["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "NO_PROXY", "no_proxy"].sort()));

// ===================== (a) markitdown: fixed addition (not a catalog row) =====================
{
  const mcpServers = buildMcpServers({ sessionId: "s-markitdown", port: 4317, role: "worker", documentConversion: true });
  const unwrapped = unwrapLauncherMount(mcpServers.markitdown);
  check("(a) markitdown mounted", unwrapped !== null);
  for (const k of PROXY_ENV_KEYS) {
    check(`(a) markitdown's --allow list carries ${k}`, unwrapped?.allowKeys.includes(k));
  }
}

// ===================== (b) the SEEDED github-binary capability (kind:"github-binary") =====================
const githubBinaryRow = {
  id: "cap-fake-github", slug: "github", name: "GitHub", description: "", transport: "stdio", kind: "github-binary",
  provisionJson: JSON.stringify({ kind: "github-binary", version: "0.0.0-test" }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: [], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-github", port: 4317, role: "worker",
    capabilities: [{ slug: "github" }], capabilityCatalog: [githubBinaryRow],
  });
  const unwrapped = unwrapLauncherMount(mcpServers.github);
  check("(b) the seeded github-binary capability mounted", unwrapped !== null);
  for (const k of PROXY_ENV_KEYS) {
    check(`(b) the seeded github-binary capability's --allow list carries ${k}`, unwrapped?.allowKeys.includes(k));
  }
}

// ===================== (c) an IMPOSTOR row: same slug "github", wrong kind — must NOT be entitled =====================
// Proves the entitlement is keyed on `def.kind === "github-binary"`, never on `def.slug`/name — an owner
// who deletes the seeded "github" row and recreates one with the same slug (kind forced to a non-seed-only
// value by validateCapabilityDefInput) must never inherit the proxy-credential forwarding.
const impostorRow = {
  id: "cap-impostor-github", slug: "github", name: "GitHub", description: "", transport: "stdio", kind: "command",
  provisionJson: JSON.stringify({ kind: "command", command: process.execPath, args: [] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: [], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-impostor", port: 4317, role: "worker",
    capabilities: [{ slug: "github" }], capabilityCatalog: [impostorRow],
  });
  const unwrapped = unwrapLauncherMount(mcpServers.github);
  check("(c) the impostor (slug 'github', kind 'command') row mounted", unwrapped !== null);
  for (const k of PROXY_ENV_KEYS) {
    check(`(c) the impostor row's --allow list does NOT carry ${k} (keyed on kind, not slug)`, !unwrapped?.allowKeys.includes(k));
  }
}

// ===================== (d) an ordinary owner-added capability, no passEnv: no proxy keys either =====================
const plainRow = {
  id: "cap-plain", slug: "plain-thing", name: "Plain Thing", description: "", transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: [], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-plain", port: 4317, role: "worker",
    capabilities: [{ slug: "plain-thing" }], capabilityCatalog: [plainRow],
  });
  const unwrapped = unwrapLauncherMount(mcpServers["plain-thing"]);
  check("(d) the plain owner-added row mounted", unwrapped !== null);
  for (const k of PROXY_ENV_KEYS) {
    check(`(d) a plain owner-added row with no passEnv does NOT carry ${k}`, !unwrapped?.allowKeys.includes(k));
  }
}

// ===================== (e) REAL spawn: an owner-added row's OWN passEnv:["HTTPS_PROXY"] still works =====================
// Unaffected by this card — the pre-existing opt-in mechanism, exercised here with a proxy-shaped key
// name specifically (manager's own test-plan item), proving the raw credentialed value reaches the
// process end to end, not just the allow-list computation.
const passEnvProxyRow = {
  id: "cap-passenv-proxy", slug: "passenv-proxy-fixture", name: "PassEnv Proxy Fixture", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: ["HTTPS_PROXY"], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-passenv-proxy", port: 4317, role: "worker",
    capabilities: [{ slug: "passenv-proxy-fixture" }], capabilityCatalog: [passEnvProxyRow],
  });
  const resolved = mcpServers["passenv-proxy-fixture"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(e) the fixture row's --allow list carries the owner's own passEnv:['HTTPS_PROXY']", unwrapped?.allowKeys.includes("HTTPS_PROXY"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, {
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      HTTPS_PROXY: "http://corpuser:corppass@proxy.corp.example:8080",
      HTTP_PROXY: "http://corpuser:corppass@proxy.corp.example:8080", // NOT in this row's passEnv — must NOT survive
    },
  });
  const echoed = JSON.parse(stdout);
  check("(e) the real spawned target received the owner's passEnv-named HTTPS_PROXY, credentials included",
    echoed.env.HTTPS_PROXY === "http://corpuser:corppass@proxy.corp.example:8080");
  check("(e) the real spawned target did NOT receive HTTP_PROXY (not named in this row's passEnv)", !("HTTP_PROXY" in echoed.env));
}

// ===================== (f) browserTesting:true: the Playwright mount gets NO PROXY_ENV_KEYS =====================
{
  const mcpServers = buildMcpServers({ sessionId: "s-playwright", port: 4317, role: "worker", browserTesting: true });
  const unwrapped = unwrapLauncherMount(mcpServers.playwright);
  check("(f) the playwright mount resolved (is @playwright/mcp installed?)", unwrapped !== null);
  for (const k of PROXY_ENV_KEYS) {
    check(`(f) the playwright mount's --allow list does NOT carry ${k} (browserTesting has no proxy entitlement)`, !unwrapped?.allowKeys.includes(k));
  }
}

// ===================== (g) the npm-pinned image-gen mount gets NO PROXY_ENV_KEYS =====================
// Forced resolution through a FIXTURE provisionJson (kind:"bundled" → echo-env.mjs, the same trick
// image-gen-capability.mjs uses) so this never depends on a real mcp-imagenate install. `def.kind` (the
// TOP-LEVEL field the entitlement actually keys on — never `provision.kind`) stays "npm-pinned" throughout.
const imageGenRow = {
  id: "cap-image-gen", slug: "image-gen", name: "Image Generation (Gemini/Imagen)", description: "",
  transport: "stdio", kind: "npm-pinned",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: [], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-image-gen", port: 4317, role: "worker",
    capabilities: [{ slug: "image-gen" }], capabilityCatalog: [imageGenRow],
  });
  const unwrapped = unwrapLauncherMount(mcpServers["image-gen"]);
  check("(g) the npm-pinned image-gen (fixture-resolved) mount mounted", unwrapped !== null);
  for (const k of PROXY_ENV_KEYS) {
    check(`(g) the npm-pinned image-gen mount's --allow list does NOT carry ${k} (no fixed entitlement for this kind)`, !unwrapped?.allowKeys.includes(k));
  }
}

// ===================== (h) card c6da31e9: NO_PROXY reaches an entitled mount, never an unentitled one =====
// Sections (a)-(g) above already cover NO_PROXY/no_proxy's --allow-list presence/absence through the
// shared PROXY_ENV_KEYS loop (now 6 entries, not 4) for markitdown/github-binary/an impostor/a plain row/
// Playwright/image-gen. This section is the REAL-spawn proof (same shape as (e)'s HTTPS_PROXY proof) that
// the raw NO_PROXY value itself reaches — or doesn't — a real spawned process for both polarities.
const NO_PROXY_VALUE = "10.0.0.0/8,internal.corp.example";
const noProxyEntitledRow = {
  id: "cap-no-proxy-entitled", slug: "no-proxy-entitled-fixture", name: "NO_PROXY Entitled Fixture", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: ["NO_PROXY"], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-no-proxy-entitled", port: 4317, role: "worker",
    capabilities: [{ slug: "no-proxy-entitled-fixture" }], capabilityCatalog: [noProxyEntitledRow],
  });
  const resolved = mcpServers["no-proxy-entitled-fixture"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(h) an entitled fixture's --allow list carries NO_PROXY (own passEnv:['NO_PROXY'])", unwrapped?.allowKeys.includes("NO_PROXY"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, {
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      NO_PROXY: NO_PROXY_VALUE,
    },
  });
  const echoed = JSON.parse(stdout);
  check("(h) the REAL spawned target of an ENTITLED mount (own passEnv:['NO_PROXY']) receives NO_PROXY", echoed.env.NO_PROXY === NO_PROXY_VALUE);
}
{
  // Reuses (d)'s plainRow (no passEnv, kind:"bundled" — not a fixed-entitled kind) to prove the SAME
  // NO_PROXY value does NOT reach an unentitled mount's real spawned process.
  const mcpServers = buildMcpServers({
    sessionId: "s-no-proxy-unentitled", port: 4317, role: "worker",
    capabilities: [{ slug: "plain-thing" }], capabilityCatalog: [{
      ...plainRow,
      provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
    }],
  });
  const resolved = mcpServers["plain-thing"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(h) an UNentitled fixture's --allow list does NOT carry NO_PROXY (no passEnv, not a fixed-entitled kind)", !unwrapped?.allowKeys.includes("NO_PROXY"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, {
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      NO_PROXY: NO_PROXY_VALUE,
    },
  });
  const echoed = JSON.parse(stdout);
  check("(h) the REAL spawned target of an UNENTITLED mount does NOT receive NO_PROXY (moved out of BASE_ALLOWLIST)", !("NO_PROXY" in echoed.env));
}

// ===================== (i) card c6da31e9 review fix: auto-pairing — a row naming a credentialed proxy var =====
// in its OWN passEnv must also receive NO_PROXY/no_proxy, even though it never named either itself. Before
// this fix, passEnv:["HTTPS_PROXY"] (the exact shape 188d6a8c's own record tells owners to use, and (e)
// above already exercises) got the proxy WITHOUT NO_PROXY — losing the loopback/intranet exclusions
// withLoopbackNoProxy folds into the base env, so those requests would now go through the proxy. A row
// naming NO proxy key (passEnv:[]) must still get no NO_PROXY — (d) above already proves that polarity.
const autoPairRow = {
  id: "cap-autopair-proxy", slug: "autopair-proxy-fixture", name: "Auto-Pair Proxy Fixture", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: ["HTTPS_PROXY"], createdAt: new Date().toISOString(),
};
const AUTO_PAIR_NO_PROXY_VALUE = "127.0.0.1,localhost,10.0.0.0/8";
{
  const mcpServers = buildMcpServers({
    sessionId: "s-autopair-proxy", port: 4317, role: "worker",
    capabilities: [{ slug: "autopair-proxy-fixture" }], capabilityCatalog: [autoPairRow],
  });
  const resolved = mcpServers["autopair-proxy-fixture"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(i) a row naming only passEnv:['HTTPS_PROXY'] has NO_PROXY auto-paired into its --allow list", unwrapped?.allowKeys.includes("NO_PROXY"));
  check("(i) a row naming only passEnv:['HTTPS_PROXY'] has no_proxy auto-paired into its --allow list too", unwrapped?.allowKeys.includes("no_proxy"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, {
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      HTTPS_PROXY: "http://corpuser:corppass@proxy.corp.example:8080",
      NO_PROXY: AUTO_PAIR_NO_PROXY_VALUE,
    },
  });
  const echoed = JSON.parse(stdout);
  check("(i) the real spawned target of the auto-paired mount receives NO_PROXY even though its own passEnv never named it",
    echoed.env.NO_PROXY === AUTO_PAIR_NO_PROXY_VALUE);
}
{
  // (d)'s plainRow already proves passEnv:[] gets no NO_PROXY in the --allow list; re-prove the REAL-spawn
  // polarity too, same shape as the rest of this file's real-spawn pairs.
  const mcpServers = buildMcpServers({
    sessionId: "s-autopair-noproxy-row", port: 4317, role: "worker",
    capabilities: [{ slug: "plain-thing" }], capabilityCatalog: [{
      ...plainRow,
      provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
    }],
  });
  const resolved = mcpServers["plain-thing"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(i) a row naming no proxy key (passEnv:[]) still has no NO_PROXY auto-paired in", !unwrapped?.allowKeys.includes("NO_PROXY"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, {
    env: {
      PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
      NO_PROXY: AUTO_PAIR_NO_PROXY_VALUE,
    },
  });
  const echoed = JSON.parse(stdout);
  check("(i) the real spawned target of a passEnv:[] row does NOT receive NO_PROXY", !("NO_PROXY" in echoed.env));
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — proxy env-key entitlement (cards 188d6a8c, d2fece1f, c6da31e9, c6da31e9-review): markitdown and the seeded github-binary capability get PROXY_ENV_KEYS (a fixed addition / kind-keyed respectively, now including NO_PROXY/no_proxy); a same-slug impostor row, an ordinary owner-added row with no passEnv, a browserTesting:true Playwright mount, and the npm-pinned image-gen mount all get neither; REAL child_process spawns prove both an owner's own passEnv:['HTTPS_PROXY'] and passEnv:['NO_PROXY'] forward the raw value end to end while an unentitled mount receives neither; and a row naming ONLY a credentialed proxy var in its own passEnv now has NO_PROXY/no_proxy auto-paired in, proven both in the --allow list and via a real spawn — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
