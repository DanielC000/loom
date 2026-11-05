import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b9b34a35 (child 6 of the SSH epic a3d5c7f4): the MCP mount that serves `ssh_exec` must stay Tier 0
// (loopback-only) in gateway/trust-tier.ts. HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via
// app.inject, like trust-tier.mjs).
//
// The mount is DERIVED from the real source, never hard-coded: (1) every src/mcp/*.ts that registers the
// tool name is found by text scan; (2) the exported router class in that file is matched to the type the
// gateway imports and to the GatewayDeps field of that type; (3) the `app.all("<pattern>", ...)` block whose
// handler calls `deps.<field>.handle(` yields the mount pattern. If any derivation step stops resolving the
// test FAILS LOUD rather than passing over an empty list.
//
// Proves: (a) neither TIER_1_ROUTES nor TIER_2_ROUTES (parsed from trust-tier.ts source text) holds a rule
// whose pattern is the mount or sits under it; (b) the real `routeTier` is 0 for the mount under every HTTP
// method; (c) with remote access on, a REMOTE request to the mount is refused 403 (with no token, with a
// valid gateway token, and with a bogus one), while a LOOPBACK request is not refused by the tier wall;
// (d) POSITIVE CONTROL: a known Tier-1 route IS admitted remotely with the token, so the refusals above are
// the wall acting and not a harness that refuses everything.
// NOT covered: the per-session MCP bearer (`verifyMcpToken`) behind the wall, and the other six /mcp-* mounts
// (trust-tier.mjs covers /mcp/:sessionId's 403 and the default-deny totality over the live route table).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src");

const TMP = mkdtempManaged("loom-ssh-tier-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45343";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Full-line `//` comments only: a naive block/trailing-comment strip mis-fires on `/*` or `//` inside string
// literals (it hid the registration below on a first attempt, and halved the parsed tier list).
const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, "");

// --- (0) derive the mount(s) that serve ssh_exec from the real source ----------------------------------
// Scan the WHOLE src tree (not just src/mcp): a registrar outside mcp/ would otherwise go unseen.
const walkTs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walkTs(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
const registrarPaths = walkTs(SRC)
  .filter((f) => /registerTool\(\s*["'`]ssh_exec["'`]/.test(stripComments(fs.readFileSync(f, "utf8"))));
const registrars = registrarPaths.map((f) => path.relative(SRC, f).split(path.sep).join("/"));
check(`(0a) some src file registers the "ssh_exec" tool name (found: ${registrars.join(", ") || "none"})`, registrars.length >= 1);
check("(0a2) every registrar lives under src/mcp/ (the gateway derivation below imports it as ../mcp/<file>.js)", registrars.every((r) => /^mcp\/[^/]+\.ts$/.test(r)));

const gatewaySrc = stripComments(fs.readFileSync(path.join(SRC, "gateway", "server.ts"), "utf8"));
const mounts = new Set();
// Every `app.<verb>("<pattern>", ...)` / `app.route({ url: "<pattern>" ...})` registration, with its body up to
// the next registration. Not just app.all: a mount registered per-verb must be found too.
const REG_RE = /\bapp\.(?:(?:all|get|post|put|delete|patch|head|options)\(\s*"([^"]+)"|route\(\s*\{[^}]*?\burl:\s*"([^"]+)")/g;
const regs = [...gatewaySrc.matchAll(REG_RE)];
const blocks = regs.map((m, i) => ({ pattern: m[1] ?? m[2], body: gatewaySrc.slice(m.index, regs[i + 1]?.index ?? gatewaySrc.length) }));
check(`(0b0) parsed a non-trivial gateway registration list (${blocks.length}, floor 100) — an empty parse would derive nothing`, blocks.length >= 100);
for (const f of registrars) {
  const base = f.replace(/^mcp\//, "").replace(/\.ts$/, "");
  const before = mounts.size;
  const mountsOfThisRegistrar = new Set();
  const imp = new RegExp(`import\\s+type\\s*\\{\\s*(\\w+)\\s*\\}\\s*from\\s*"\\.\\./mcp/${base}\\.js"`).exec(gatewaySrc);
  check(`(0b) gateway/server.ts imports the router type from mcp/${base}.js (${imp?.[1] ?? "none"})`, !!imp);
  if (!imp) continue;
  const field = new RegExp(`(\\w+)\\??\\s*:\\s*${imp[1]}\\b`).exec(gatewaySrc);
  check(`(0c) GatewayDeps has a field typed ${imp[1]} (${field?.[1] ?? "none"})`, !!field);
  if (!field) continue;
  for (const b of blocks) if (b.body.includes(`deps.${field[1]}.handle(`)) { mounts.add(b.pattern); mountsOfThisRegistrar.add(b.pattern); }
  check(`(0d0) registrar ${f} yields at least one mount on its own (${[...mountsOfThisRegistrar].join(", ") || "none"})`, mountsOfThisRegistrar.size >= 1 && before <= mounts.size);
}
const MOUNTS = [...mounts];
check(`(0d) derived at least one mount serving ssh_exec (found: ${MOUNTS.join(", ") || "none"})`, MOUNTS.length >= 1 && MOUNTS.every((m) => m.startsWith("/mcp")));

// Does a rule pattern name the mount, or sit under its static prefix (the part before the first :param)?
const staticPrefix = (p) => p.split("/:")[0];
const coversMount = (rulePattern, mount) => rulePattern === mount || rulePattern.startsWith(`${staticPrefix(mount)}/`) || rulePattern === staticPrefix(mount);

// --- (a) the tier allowlists hold no rule for the mount ------------------------------------------------
const tierSrc = stripComments(fs.readFileSync(path.join(SRC, "gateway", "trust-tier.ts"), "utf8"));
function ruleList(name) {
  const m = new RegExp(`const\\s+${name}\\s*:\\s*readonly\\s+TierRule\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(tierSrc);
  if (!m) return null;
  const rules = [...m[1].matchAll(/\{\s*method:\s*"([A-Z]+)"\s*,\s*pattern:\s*"([^"]+)"\s*\}/g)].map((r) => ({ method: r[1], pattern: r[2] }));
  // Self-check: the strict single-line rule shape must account for EVERY `pattern:` token and no `...` spread,
  // so a multi-line / reversed-key / single-quoted / spread entry fails loud instead of being skipped.
  const patternTokens = (m[1].match(/\bpattern\s*:/g) ?? []).length;
  const spreads = (m[1].match(/\.\.\./g) ?? []).length;
  check(`(a-parse) ${name}: pattern: tokens (${patternTokens}) equal parsed rules (${rules.length}) and no spread (${spreads})`, patternTokens === rules.length && spreads === 0);
  return rules;
}
const t1 = ruleList("TIER_1_ROUTES");
const t2 = ruleList("TIER_2_ROUTES");
check(`(a-sanity) parsed a non-trivial TIER_1_ROUTES list (${t1?.length ?? "null"} rules, floor 50) — an empty parse would pass (a) vacuously`, !!t1 && t1.length >= 50);
check(`(a-sanity) parsed TIER_2_ROUTES (${t2?.length ?? "null"} rules, floor 1)`, !!t2 && t2.length >= 1);
for (const mount of MOUNTS) {
  check(`(a1) no TIER_1_ROUTES rule covers ${mount}`, !!t1 && !t1.some((r) => coversMount(r.pattern, mount)));
  check(`(a2) no TIER_2_ROUTES rule covers ${mount}`, !!t2 && !t2.some((r) => coversMount(r.pattern, mount)));
}

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");

// --- (b) the real routeTier classifies the mount Tier 0 for every method -------------------------------
for (const mount of MOUNTS) {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    check(`(b) routeTier(${method}, ${mount}) === 0`, routeTier(method, mount) === 0);
  }
}
check("(b-control) routeTier(GET, /api/projects) === 1 — a known Tier-1 route classifies 1, so (b)'s 0s can fail", routeTier("GET", "/api/projects") === 1);
check("(b-control) routeTier(POST, /hooks/:endpointPath) === 2 — a known Tier-2 route classifies 2", routeTier("POST", "/hooks/:endpointPath") === 2);

// --- (c) end to end through the real onRequest wall ------------------------------------------------------
const GOOD_TOKEN = "test-valid-gateway-token";
const db = new Db(path.join(TMP, "loom.db"));
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "0.0.0.0" } });
const app = await buildServer({
  db, pty: {}, sessions: { killAllWorkers: () => 0 }, mcp: {}, orchMcp: {},
  platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {}, runMcp: {}, control: {}, usageStatus: {},
  requestShutdown: () => {},
  verifyGatewayToken: (token) => token === GOOD_TOKEN,
});
try {
  const REMOTE = "203.0.113.9";
  for (const mount of MOUNTS) {
    const url = mount.replace(/:[A-Za-z]+/g, "some-session");
    const bare = await app.inject({ method: "POST", url, remoteAddress: REMOTE });
    check(`(c1) remote POST ${url} with no token → 403`, bare.statusCode === 403);
    const tokened = await app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
    check(`(c2) remote POST ${url} with a VALID gateway token → still 403 (a Tier-1 token must not unlock Tier 0)`, tokened.statusCode === 403);
    const bogus = await app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { authorization: "Bearer wrong" } });
    check(`(c3) remote POST ${url} with a bogus token → 403`, bogus.statusCode === 403);
    const spoof = await app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "x-forwarded-for": "127.0.0.1" } });
    check(`(c4) remote POST ${url} spoofing X-Forwarded-For: 127.0.0.1 → still 403`, spoof.statusCode === 403);
    const getRemote = await app.inject({ method: "GET", url, remoteAddress: REMOTE, headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
    check(`(c5) remote GET ${url} with a valid gateway token → 403`, getRemote.statusCode === 403);
    // Loopback is NOT refused by the tier wall: it reaches the per-session MCP bearer check (401), never 403.
    const loop = await app.inject({ method: "POST", url });
    check(`(c6) loopback POST ${url} reaches the MCP-bearer hook → 401 (got ${loop.statusCode}), not the tier wall's 403`, loop.statusCode === 401);
  }
  // POSITIVE CONTROL: the same harness admits a known Tier-1 route remotely — so (c)'s 403s are the wall.
  const noTok = await app.inject({ method: "GET", url: "/api/projects", remoteAddress: REMOTE });
  check("(c-control) remote GET /api/projects (Tier 1) with no token → 401, not 403", noTok.statusCode === 401);
  const withTok = await app.inject({ method: "GET", url: "/api/projects", remoteAddress: REMOTE, headers: { authorization: `Bearer ${GOOD_TOKEN}` } });
  check("(c-control) remote GET /api/projects (Tier 1) with a valid token → 200 (admitted)", withTok.statusCode === 200);
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the mount serving ssh_exec is in no tier allowlist, routeTier is 0 for it under every method, and a remote request is refused 403 (a known Tier-1 route is admitted as the control)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
