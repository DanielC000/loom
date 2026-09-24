import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 07ce7c0c — Code Reviewer follow-up on 80b7a33b's `platform_config_get` forensics read. That read's
// `sanitizePlatformConfigForAgent` (mcp/platform.ts) is a fail-OPEN DENYLIST: it drops `integrations`
// (codescape) + collapses `remoteAccess.tls.{certPath,keyPath}`, then spreads everything else in
// `PlatformConfigOverride` verbatim to the agent surface. Correct TODAY (audited every field at 80b7a37b),
// but nothing catches a FUTURE secret/host-path field added to the override shape — it would ship to the
// Lead unredacted with no test failing. Mirrors `agent-prompt-lint-surface-drift.mjs`'s exact-set match
// style: a hand-authored expected key list vs. the schema's REAL live key set (`PLATFORM_CONFIG_TOP_LEVEL_
// KEYS`, derived once from `platformConfigOverrideSchema.shape` so it can't itself drift from the
// validator). A key added to the schema without a matching entry in EXPECTED_KEYS fails this test —
// forcing an explicit redact-or-expose decision in `sanitizePlatformConfigForAgent` (and this file) at add
// time, instead of silently reaching the agent surface unredacted.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-config-redaction-drift.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pcrd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { PLATFORM_CONFIG_TOP_LEVEL_KEYS, PLATFORM_CONFIG_REMOTE_ACCESS_KEYS, redactRemoteAccessForAgentForTest } = await import("../dist/mcp/platform.js");

try {
  // Hand-authored: every top-level PlatformConfigOverride key `sanitizePlatformConfigForAgent` has been
  // audited against, as of card 80b7a33b/07ce7c0c. Each key is EITHER redacted (integrations,
  // remoteAccess — the latter only its nested tls.{certPath,keyPath}) OR confirmed plain operational
  // tuning with no credential/host-path shape (everything else). Adding a key to
  // `platformConfigOverrideSchema` without adding it here (and to `sanitizePlatformConfigForAgent` if it
  // needs redaction) fails this test.
  const EXPECTED_KEYS = [
    "rateLimit",
    "watchers",
    "timeouts",
    "backup",
    "gateRetry",
    "harness", // card 66b1b40d — default vendor CLI + scope: plain operational tuning, no secret/host-path shape; passes through unredacted
    "connections",
    "integrations", // REDACTED — dropped entirely (codescape path; see codescape-is-private-no-user-visible-surface)
    "coalesceAgentMessages",
    "companionVoiceEnabled",
    "operatorEnabled",
    "remoteAccess", // PARTIALLY REDACTED — tls.{certPath,keyPath} collapses to {configured}; rest passes through
    "schedulerEnabled",
    "maxConcurrentGates",
    "maxConcurrentManagers",
    "maxConcurrentAuditors",
    "usageSampleIntervalMs",
    "usageSampleRetentionDays",
    "updateCheckIntervalMs",
  ];

  const actual = [...PLATFORM_CONFIG_TOP_LEVEL_KEYS].sort();
  const expected = [...EXPECTED_KEYS].sort();
  const missing = expected.filter((k) => !actual.includes(k)); // in EXPECTED_KEYS but the schema no longer has it
  const extra = actual.filter((k) => !expected.includes(k)); // the schema has it but EXPECTED_KEYS doesn't know it — the drift case

  if (missing.length || extra.length) {
    console.log(`  drift: expected-only=[${missing.join(",")}] schema-only=[${extra.join(",")}]`);
  }
  check(
    "PLATFORM_CONFIG_TOP_LEVEL_KEYS matches the audited EXPECTED_KEYS list — no un-redaction-reviewed key has been added",
    JSON.stringify(actual) === JSON.stringify(expected),
  );
  check("sanity: the key set is non-empty (a vacuous pass would hide a broken import)", actual.length > 0);

  // ---- remoteAccess SUB-keys (card 23496950): the top-level pin above cannot see a field added INSIDE
  // remoteAccess, which `sanitizePlatformConfigForAgent` spreads verbatim except `tls`. Every sub-key needs an
  // explicit decision here: REDACT (tls — host paths to TLS private-key material) or EXPOSE. `port` and
  // `allowedHosts` are EXPOSED, the same class as `bindHost`: a port number and hostnames — network posture the
  // Lead legitimately reads, no credential, no host filesystem path.
  const EXPECTED_REMOTE_ACCESS_KEYS = [
    "enabled",
    "bindHost",
    "port", // EXPOSED — a port number, same class as bindHost
    "allowedHosts", // EXPOSED — hostnames/IPs clients dial, same class as bindHost
    "tls", // REDACTED — {certPath,keyPath} collapses to {configured:true}
    "rateLimit",
  ];
  const raActual = [...PLATFORM_CONFIG_REMOTE_ACCESS_KEYS].sort();
  const raExpected = [...EXPECTED_REMOTE_ACCESS_KEYS].sort();
  if (JSON.stringify(raActual) !== JSON.stringify(raExpected)) {
    console.log(`  drift: expected-only=[${raExpected.filter((k) => !raActual.includes(k)).join(",")}] schema-only=[${raActual.filter((k) => !raExpected.includes(k)).join(",")}]`);
  }
  check("PLATFORM_CONFIG_REMOTE_ACCESS_KEYS matches the audited EXPECTED_REMOTE_ACCESS_KEYS — no un-reviewed remoteAccess sub-key has been added", JSON.stringify(raActual) === JSON.stringify(raExpected));
  check("sanity: the remoteAccess sub-key set is non-empty", raActual.length > 0);
  // Behaviour, not just names: the real agent-facing redaction collapses tls but passes port/allowedHosts through.
  const ra = { enabled: true, bindHost: "0.0.0.0", port: 4318, allowedHosts: ["192.168.1.50"], tls: { certPath: "/secret/cert.pem", keyPath: "/secret/key.pem" } };
  const shown = redactRemoteAccessForAgentForTest(ra);
  check("agent redaction: tls host paths are collapsed to {configured:true}",
    JSON.stringify(shown.tls) === '{"configured":true}' && !JSON.stringify(shown).includes("/secret/"));
  check("agent redaction: port and allowedHosts pass through unredacted (the recorded EXPOSE decision)",
    shown.port === 4318 && JSON.stringify(shown.allowedHosts) === '["192.168.1.50"]' && shown.enabled === true && shown.bindHost === "0.0.0.0");
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PlatformConfigOverride's top-level key set matches the audited expected list; a new key would fail this test until sanitizePlatformConfigForAgent (and this file's EXPECTED_KEYS) make an explicit redact-or-expose call on it."
  : `\n❌ ${failures} FAILURE(S) — a PlatformConfigOverride key was added/removed without updating this drift guard. If ADDED: decide in mcp/platform.ts's sanitizePlatformConfigForAgent whether the agent surface may see it, then add it to this file's EXPECTED_KEYS.`);
process.exit(failures === 0 ? 0 : 1);
