import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1)
// Card 6782509b — hermetic, no-real-claude test of the COMPUTED spawn env: every Loom-spawned session
// (claude + codex both go through buildSpawnEnv) must bypass any HTTP proxy for loopback, so a proxy
// relaying MCP/hook-relay calls can't add Via/X-Forwarded-* headers that make the daemon see them as remote.
import assert from "node:assert/strict";
import { buildSpawnEnv } from "../dist/pty/host.js";

const LOOP = ["127.0.0.1", "localhost", "::1"];
const parts = (v) => (v ?? "").split(",");
let fails = 0;
function t(name, fn) { try { fn(); console.log("PASS", name); } catch (e) { fails++; console.log("FAIL", name, "-", e.message); } }

t("absent => set (both case variants)", () => {
  const env = buildSpawnEnv({ PATH: "x" }, {}, "/w");
  for (const k of ["NO_PROXY", "no_proxy"]) assert.deepEqual(parts(env[k]), LOOP);
});
t("present with other hosts => union, both keys identical", () => {
  const env = buildSpawnEnv({ NO_PROXY: "corp.example, .internal", no_proxy: "other.example" }, {}, "/w");
  const u = ["corp.example", ".internal", "other.example", ...LOOP];
  assert.deepEqual(parts(env.NO_PROXY), u);
  assert.deepEqual(parts(env.no_proxy), u);
});
t("only NO_PROXY with other hosts => both keys equal the full union (Windows case-insensitivity)", () => {
  const env = buildSpawnEnv({ NO_PROXY: "corp.local" }, {}, "/w");
  assert.deepEqual(parts(env.NO_PROXY), ["corp.local", ...LOOP]);
  assert.equal(env.no_proxy, env.NO_PROXY);
});
t("only no_proxy with other hosts => both keys equal the full union", () => {
  const env = buildSpawnEnv({ no_proxy: "a.example" }, {}, "/w");
  assert.deepEqual(parts(env.NO_PROXY), ["a.example", ...LOOP]);
  assert.equal(env.no_proxy, env.NO_PROXY);
});
t("already contains them => no duplicates", () => {
  const env = buildSpawnEnv({ NO_PROXY: "localhost,127.0.0.1", no_proxy: "::1,LOCALHOST" }, {}, "/w");
  assert.deepEqual(parts(env.NO_PROXY), ["localhost", "127.0.0.1", "::1"]);
  assert.equal(env.no_proxy, env.NO_PROXY);
});
t("arbitrary-case variant (No_Proxy, as a win32 env copy can carry) is folded in and removed", () => {
  const env = buildSpawnEnv({ No_Proxy: "mixed.example", NO_PROXY: "up.example" }, {}, "/w");
  assert.deepEqual(parts(env.NO_PROXY), ["mixed.example", "up.example", ...LOOP]);
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.No_Proxy, undefined);
  assert.equal(Object.keys(env).filter((k) => k.toLowerCase() === "no_proxy").length, 2);
});
t("sessionEnv override is unioned with the inherited value, not clobbering it", () => {
  const env = buildSpawnEnv({ NO_PROXY: "inherited.example" }, { NO_PROXY: "override.example" }, "/w");
  assert.deepEqual(parts(env.NO_PROXY), ["override.example", ...LOOP]);
  assert.equal(env.no_proxy, env.NO_PROXY);
});
t("empty / stray-comma value is normalised", () => {
  const env = buildSpawnEnv({ NO_PROXY: ",," }, {}, "/w");
  assert.deepEqual(parts(env.NO_PROXY), LOOP);
  assert.equal(env.no_proxy, env.NO_PROXY);
});
t("existing recipe unchanged: scrub + git-safety vars + proxy var passthrough", () => {
  const env = buildSpawnEnv({ CLAUDECODE: "1", CLAUDE_CODE_X: "1", HTTP_PROXY: "http://p:1" }, {}, "/w");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_X, undefined);
  assert.equal(env.HTTP_PROXY, "http://p:1");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.LOOM_WORKTREE, "/w");
});
process.exit(fails ? 1 : 0);
