import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9223fe84 (c) — read-only detection of claude settings files carrying routing keys
// (env.ANTHROPIC_* etc. / apiKeyHelper). Proves: key-NAME-only reporting (a planted sentinel secret value
// never appears in the result, the log line, or the served_status payload), the user-level and
// worktree-level cases, available:false on a failed scan (never read as clean), and that the per-spawn
// scan is fire-and-forget (the kick returns before a never-settling fs read, and host.ts does not await it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-csr-home-");
requireHermeticEnv();

const scan = await import("../dist/pty/claude-settings-routing-scan.js");
const { buildServedStatus } = await import("../dist/served-status.js");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — ${detail}`}`);
};

const SENTINEL = "sk-SENTINEL-SECRET-VALUE-9223fe84";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csr-"));
const write = (dir, name, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), typeof obj === "string" ? obj : JSON.stringify(obj)); };

// (1) predicate
check("predicate: ANTHROPIC_BASE_URL (any case) is a routing key", scan.isClaudeRoutingEnvKey("ANTHROPIC_BASE_URL") && scan.isClaudeRoutingEnvKey("anthropic_api_key"));
check("predicate: AWS_BEARER_TOKEN_BEDROCK + CLAUDE_CODE_USE_BEDROCK are routing keys", scan.isClaudeRoutingEnvKey("AWS_BEARER_TOKEN_BEDROCK") && scan.isClaudeRoutingEnvKey("CLAUDE_CODE_USE_BEDROCK"));
check("predicate: unrelated env key is NOT a routing key", !scan.isClaudeRoutingEnvKey("CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING") && !scan.isClaudeRoutingEnvKey("PATH"));
check("negative control: a bogus key matches nothing", !scan.isClaudeRoutingEnvKey("NOPE_BOGUS_KEY_XYZ"));
const { isAnthropicSpawnEnvKey } = await import("../dist/pty/anthropic-env-key.js");
check("predicate: superset of the c8eeda93 scrub predicate (same function) + provider switches",
  ["ANTHROPIC_X", "anthropic_y", "AWS_BEARER_TOKEN_BEDROCK", "PATH"].every((k) => !isAnthropicSpawnEnvKey(k) || scan.isClaudeRoutingEnvKey(k))
  && scan.isClaudeRoutingEnvKey("claude_code_use_vertex") && scan.isClaudeRoutingEnvKey("CLAUDE_CODE_USE_FOUNDRY") && !isAnthropicSpawnEnvKey("CLAUDE_CODE_USE_VERTEX"));

// (2) pure text scan
check("text: env routing keys + apiKeyHelper reported by NAME", JSON.stringify(scan.routingKeysInSettingsText(JSON.stringify({ env: { ANTHROPIC_API_KEY: SENTINEL, FOO: "x" }, apiKeyHelper: SENTINEL }))) === JSON.stringify(["ANTHROPIC_API_KEY", "apiKeyHelper"]));
check("text: non-routing env only → []", scan.routingKeysInSettingsText('{"env":{"CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING":"1"}}').length === 0);
check("text: unparseable → null (not [])", scan.routingKeysInSettingsText("{not json") === null);

// (3) user-level dir scan
const userBase = path.join(tmp, "userhome");
write(path.join(userBase, ".claude"), "settings.json", { env: { ANTHROPIC_BASE_URL: SENTINEL, OK: "1" } });
write(path.join(userBase, ".claude"), "settings.local.json", { permissions: {} });
const u = await scan.scanSettingsDir(path.join(userBase, ".claude"), userBase);
check("user: finding reports file + key names only", u.available === true && u.findings.length === 1 && u.findings[0].file === ".claude/settings.json" && u.findings[0].keys.join() === "ANTHROPIC_BASE_URL", JSON.stringify(u));
check("user: SENTINEL value absent from result", !JSON.stringify(u).includes(SENTINEL));

// absent dir = clean + available
const none = await scan.scanSettingsDir(path.join(tmp, "nodir", ".claude"), path.join(tmp, "nodir"));
check("absent files → available:true, no findings", none.available === true && none.findings.length === 0);

// failure paths never read as clean
const badBase = path.join(tmp, "bad");
write(path.join(badBase, ".claude"), "settings.json", "{broken");
const bad = await scan.scanSettingsDir(path.join(badBase, ".claude"), badBase);
check("unparseable file → available:false with reason (NOT clean)", bad.available === false && /^unparseable:/.test(bad.reason ?? ""), JSON.stringify(bad));
const eacces = await scan.scanSettingsDir(path.join(tmp, "x", ".claude"), path.join(tmp, "x"), { readCapped: async () => { const e = new Error("denied"); e.code = "EACCES"; throw e; } });
check("read failure (EACCES) → available:false (NOT clean)", eacces.available === false && /EACCES/.test(eacces.reason ?? ""), JSON.stringify(eacces));

// byte cap: a file larger than the cap is read only up to the cap
const bigBase = path.join(tmp, "big");
write(path.join(bigBase, ".claude"), "settings.json", " ".repeat(5000) + JSON.stringify({ env: { ANTHROPIC_API_KEY: "v" } }));
const big = await scan.scanSettingsDir(path.join(bigBase, ".claude"), bigBase, undefined, 1000);
check("byte cap: oversize file → available:false, reason oversize:<file> (NOT clean, NOT unparseable)", big.available === false && /^oversize:\.claude\/settings\.json$/.test(big.reason ?? ""), JSON.stringify(big));
// boundary: a valid file of EXACTLY maxBytes is not oversize
const exact = JSON.stringify({ env: { ANTHROPIC_API_KEY: "v" } });
const exBase = path.join(tmp, "exact");
write(path.join(exBase, ".claude"), "settings.json", exact);
const exactRes = await scan.scanSettingsDir(path.join(exBase, ".claude"), exBase, undefined, Buffer.byteLength(exact));
check("byte cap boundary: file of exactly maxBytes is scanned, not oversize", exactRes.available === true && exactRes.findings.length === 1, JSON.stringify(exactRes));

// (3b) log-injection hardening: key names come from worker-writable files
const FORGED = "ANTHROPIC_X\n[boot] FORGED";
const ESC = "ANTHROPIC_Y\u001b[31m";
const hostile = {};
hostile[FORGED] = "v"; hostile[ESC] = "v"; hostile.ANTHROPIC_OK = SENTINEL;
const hBase = path.join(tmp, "hostile");
write(path.join(hBase, ".claude"), "settings.json", { env: hostile });
const h = await scan.scanSettingsDir(path.join(hBase, ".claude"), hBase);
const hLine = scan.formatFindings(h.findings);
check("sanitize: names listed are only the safe one, the rest counted", JSON.stringify(h.findings[0]?.keys) === JSON.stringify(["ANTHROPIC_OK", "+2 unprintable"]), JSON.stringify(h.findings));
check("sanitize: no newline/ESC/FORGED reaches the formatted line or the payload", !/[\n\r\u001b]/.test(hLine) && !JSON.stringify(h).includes("FORGED") && !hLine.includes("FORGED") && !JSON.stringify(h).includes("\\u001b"), JSON.stringify(hLine));
const many = {};
for (let i = 0; i < 1000; i++) many[`ANTHROPIC_K${i}`] = "v";
const mBase = path.join(tmp, "many");
write(path.join(mBase, ".claude"), "settings.json", { env: many });
const m = await scan.scanSettingsDir(path.join(mBase, ".claude"), mBase);
check("cap: 1000 keys → 20 names + '+980 more'", m.findings[0].keys.length === 21 && m.findings[0].keys[20] === "+980 more", JSON.stringify(m.findings[0].keys.slice(18)));
check("cap: formatted line is bounded", scan.formatFindings(m.findings).length < 600, String(scan.formatFindings(m.findings).length));
const longName = "ANTHROPIC_" + "A".repeat(200);
const lBase = path.join(tmp, "longname");
write(path.join(lBase, ".claude"), "settings.json", { env: { [longName]: "v" } });
const l = await scan.scanSettingsDir(path.join(lBase, ".claude"), lBase);
check("sanitize: a >128-char name is counted, not echoed", JSON.stringify(l.findings[0].keys) === JSON.stringify(["+1 unprintable"]), JSON.stringify(l.findings));

// (4) boot scan → log line + served_status payload.
// CLAUDE_CONFIG_DIR set: the CLI reads <dir>/settings.json (the env var REPLACES ~/.claude — NO extra `.claude` level).
const cfgDir = path.join(tmp, "cfgdir");
write(cfgDir, "settings.json", { env: { ANTHROPIC_BASE_URL: SENTINEL, OK: "1" } });
const logs = [];
const origWarn = console.warn;
console.warn = (...a) => { logs.push(a.join(" ")); };
process.env.CLAUDE_CONFIG_DIR = cfgDir;
const bootStatus = await scan.runBootClaudeSettingsRoutingScan();
console.warn = origWarn;
check("boot scan (CLAUDE_CONFIG_DIR set): finds <dir>/settings.json", bootStatus.available && bootStatus.findings.length === 1 && bootStatus.findings[0].file === "settings.json", JSON.stringify(bootStatus));
check("boot log: one line naming file + key, no value", logs.length === 1 && logs[0].includes("ANTHROPIC_BASE_URL") && logs[0].includes("settings.json") && !logs.join("\n").includes(SENTINEL), logs.join("|"));
// a decoy at the OLD (wrong) <dir>/.claude/ location must NOT be what the scan reads
const decoyDir = path.join(tmp, "cfgdir-decoy");
write(path.join(decoyDir, ".claude"), "settings.json", { env: { ANTHROPIC_BASE_URL: SENTINEL } });
process.env.CLAUDE_CONFIG_DIR = decoyDir;
console.warn = () => {};
const decoyStatus = await scan.runBootClaudeSettingsRoutingScan();
console.warn = origWarn;
check("boot scan (env set): <dir>/.claude/settings.json is NOT scanned (CLI does not read it)", decoyStatus.available === true && decoyStatus.findings.length === 0, JSON.stringify(decoyStatus));
// CLAUDE_CONFIG_DIR unset: <home>/.claude/settings.json
delete process.env.CLAUDE_CONFIG_DIR;
const fakeHome = path.join(tmp, "fakehome");
write(path.join(fakeHome, ".claude"), "settings.json", { env: { ANTHROPIC_API_KEY: SENTINEL } });
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = fakeHome; process.env.USERPROFILE = fakeHome;
console.warn = () => {};
const homeStatus = await scan.runBootClaudeSettingsRoutingScan();
console.warn = origWarn;
for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
check("boot scan (env unset): finds <home>/.claude/settings.json", homeStatus.available && homeStatus.findings.length === 1 && homeStatus.findings[0].file === "settings.json" && homeStatus.findings[0].keys[0] === "ANTHROPIC_API_KEY", JSON.stringify(homeStatus));
// serve the env-set result for the served_status checks below
process.env.CLAUDE_CONFIG_DIR = cfgDir;
console.warn = () => {};
await scan.runBootClaudeSettingsRoutingScan();
console.warn = origWarn;
const stubDb = { listAllSessions: () => [] };
const served = buildServedStatus(stubDb);
check("served_status carries claudeSettingsRouting {available, findings}", served.claudeSettingsRouting?.available === true && served.claudeSettingsRouting.findings[0]?.keys[0] === "ANTHROPIC_BASE_URL", JSON.stringify(served.claudeSettingsRouting));
check("served_status payload never contains the SENTINEL value", !JSON.stringify(served).includes(SENTINEL));
scan.__setClaudeSettingsRoutingStatusForTest({ available: false, reason: "not-scanned-yet", findings: [] });
check("before the scan lands, served_status says available:false (unknown, not clean)", buildServedStatus(stubDb).claudeSettingsRouting.available === false);

// (5) worktree-level per-spawn kick
const wt = path.join(tmp, "worktree");
write(path.join(wt, ".claude"), "settings.json", { env: { ANTHROPIC_AUTH_TOKEN: SENTINEL } });
const wlogs = [];
let gotLine;
const gotLineP = new Promise((r) => { gotLine = r; });
console.warn = (...a) => { wlogs.push(a.join(" ")); gotLine(); };
const ret = scan.kickWorktreeSettingsRoutingScan("sess-1234", wt);
check("kick returns synchronously (void)", ret === undefined);
await gotLineP; // anchored to the observable log line itself
console.warn = origWarn;
check("worktree: one line with session id + RELATIVE path + key name, no value", wlogs.length === 1 && wlogs[0].includes("sess-1234") && wlogs[0].includes(".claude/settings.json") && wlogs[0].includes("ANTHROPIC_AUTH_TOKEN") && !wlogs[0].includes(SENTINEL) && !wlogs[0].includes(tmp), wlogs.join("|"));

// clean worktree logs nothing (observable: scan completes via a seam promise)
const cleanWt = path.join(tmp, "cleanwt");
write(path.join(cleanWt, ".claude"), "settings.local.json", { permissions: { allow: [] } });
const clogs = [];
console.warn = (...a) => { clogs.push(a.join(" ")); };
let done;
const doneP = new Promise((r) => { done = r; });
scan.kickWorktreeSettingsRoutingScan("sess-clean", cleanWt, { readCapped: async (f, m) => { try { return await fs.promises.readFile(f, "utf8"); } finally { if (f.endsWith("settings.local.json")) done(); } } });
await doneP;
await new Promise((r) => setImmediate(r));
console.warn = origWarn;
check("clean worktree logs nothing", clogs.length === 0, clogs.join("|"));

// (6) never delays spawn: a never-settling fs read must not block the kick, and host.ts must not await it
let started = false;
const t0 = performance.now();
scan.kickWorktreeSettingsRoutingScan("sess-slow", wt, { readCapped: () => { started = true; return new Promise(() => {}); } });
const dt = performance.now() - t0;
check("never-settling fs: kick returns immediately (<50ms) without awaiting the read", dt < 50, `${dt}ms`);
const hostSrc = fs.readFileSync(new URL("../src/pty/host.ts", import.meta.url), "utf8");
check("structure: host.ts calls the kick un-awaited", /^\s*kickWorktreeSettingsRoutingScan\(opts\.sessionId, opts\.cwd\);/m.test(hostSrc) && !/await\s+kickWorktreeSettingsRoutingScan/.test(hostSrc));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\n✅ claude-settings-routing-scan OK" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
