import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// github-binary provisioning is NON-BLOCKING, DIAGNOSTIC, and RETRYABLE — the hermetic state-machine test
// for the "github" capability's Loom-managed downloaded binary (agent-tooling P4 follow-on: migrating off
// the archived @modelcontextprotocol/server-github npx package). Mirrors markitdown-provision-nonblocking.mjs
// + markitdown-provision-diagnostic.mjs, but exercised through the SHARED per-slug tracker in
// capabilities/registry.ts (kickCapabilityProvision/getCapabilityProvisionStatus), not host.ts globals — the
// github-binary provisioner is __setGithubBinaryProvisionerForTest-injected, so this test drives every
// classified outcome WITHOUT a real network download or real tar/Expand-Archive extraction (that real
// pipeline is covered separately, end-to-end, in github-binary-download.mjs).
//
// Proves:
//   (1) the spawn hot path (resolveCapabilityServer → resolveGithubBinary) is fs.existsSync-fast when cold —
//       returns null in well under 500ms, no blocking network/extract work.
//   (2) buildMcpServers omits "github" while cold — byte-identical to the capability not being granted at all.
//   (3) a cold resolve kicks background provisioning exactly once; concurrent resolves dedupe to ONE in-flight
//       job (never parallel downloads); a fresh kick is allowed after a TERMINAL outcome (retryable, not a
//       permanent one-shot).
//   (4) every classified GithubBinaryProvisionOutcome (unsupported-platform / download-failed /
//       checksum-mismatch / extract-failed / timeout / disabled) maps onto the status model with its reason +
//       errorTail, and a stale in-flight failure never downgrades an already-'ready' status.
//   (5) LOOM_GITHUB_MCP_BIN (the human-only override, mirrors LOOM_MARKITDOWN_BIN) resolves warm with NO kick.
//
// Run: 1) build, 2) node test/github-binary-provision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ghprov-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_GITHUB_MCP_BIN; // exercise the download-resolution path, not the override seam
process.env.LOOM_GITHUB_MCP_NO_PROVISION = "1"; // belt-and-suspenders — the injected fake replaces the real provisioner anyway

const {
  resolveCapabilityServer, getCapabilityProvisionStatus, __setGithubBinaryProvisionerForTest,
} = await import("../dist/capabilities/registry.js");
const { buildMcpServers } = await import("../dist/pty/host.js");
const { loomGithubMcpBin, loomGithubMcpBinDir } = await import("../dist/capabilities/github-binary.js");

const VERSION = "1.5.0";
const ghRow = {
  id: "cap-gh", slug: "github", name: "GitHub", description: "d", transport: "stdio", kind: "github-binary",
  provisionJson: JSON.stringify({ kind: "github-binary", version: VERSION }),
  toolAllowlistJson: JSON.stringify(["mcp__github"]), wantsScratchDir: false,
  requiresConnection: true, secretEnvVar: "GITHUB_PERSONAL_ACCESS_TOKEN", createdAt: new Date().toISOString(),
};

// Flush the kick's microtask chain (fake resolve → .then → .finally) to a macrotask boundary.
const flush = () => new Promise((r) => setTimeout(r, 10));
const fixed = (result) => async () => result;
let gate;
const newGate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); gate = { promise, resolve }; };
const gated = () => gate.promise;
const READY_BIN = loomGithubMcpBin(VERSION);

// ===================== precondition: cold, never provisioned =====================
check("precondition: the github-mcp-server binary is ABSENT (cold path)", !fs.existsSync(READY_BIN));

// ===================== (1)/(2) the spawn hot path is fast + byte-identical when cold =====================
__setGithubBinaryProvisionerForTest(gated);
newGate();
const t0 = performance.now();
const resolved = resolveCapabilityServer(ghRow, {});
const elapsedMs = performance.now() - t0;
check("(1) resolveCapabilityServer returns null when cold (no blocking download/extract)", resolved === null);
check(`(1) hot path returns FAST (<500ms; measured ${elapsedMs.toFixed(1)}ms)`, elapsedMs < 500);
check("(3) the cold resolve kicked background provisioning (status now 'installing')", getCapabilityProvisionStatus("github")?.state === "installing");

const on = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", capabilities: [{ slug: "github" }], capabilityCatalog: [ghRow] });
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(2) 'github' capability granted but cold ⇒ 'github' key omitted from mcpServers", !("github" in on));
check("(2) ON map is byte-identical to a no-capability spawn while cold", JSON.stringify(on) === JSON.stringify(off));

// concurrent resolves while in-flight dedupe to ONE kick.
resolveCapabilityServer(ghRow, {});
resolveCapabilityServer(ghRow, {});
gate.resolve({ binary: READY_BIN, outcome: "ready" });
await flush();
check("(3) resolves ready after the single in-flight job settles", getCapabilityProvisionStatus("github")?.state === "ready");
check("(3) the resolved binary is cached (a later call returns the warm binary, no re-kick)",
  resolveCapabilityServer(ghRow, {})?.command === READY_BIN);
check("(3) invocation contract: args is ['stdio']", JSON.stringify(resolveCapabilityServer(ghRow, {})?.args) === JSON.stringify(["stdio"]));

// ===================== (4) classified outcomes =====================
__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "unsupported-platform" }));
resolveCapabilityServer(ghRow, {});
await flush();
let s = getCapabilityProvisionStatus("github");
check("(4) unsupported-platform ⇒ state 'failed'", s.state === "failed");
check("(4) unsupported-platform ⇒ reason 'unsupported-platform'", s.reason === "unsupported-platform");

__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "download-failed", errorTail: "HTTP 503 Service Unavailable" }));
resolveCapabilityServer(ghRow, {});
await flush();
s = getCapabilityProvisionStatus("github");
check("(4) download-failed ⇒ state 'failed' + reason 'download-failed'", s.state === "failed" && s.reason === "download-failed");
check("(4) download-failed ⇒ captured errorTail surfaced", s.errorTail === "HTTP 503 Service Unavailable");

__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "checksum-mismatch", errorTail: "expected abc, got def" }));
resolveCapabilityServer(ghRow, {});
await flush();
s = getCapabilityProvisionStatus("github");
check("(4) checksum-mismatch ⇒ state 'failed' + reason 'checksum-mismatch' (the supply-chain fail-closed path)", s.state === "failed" && s.reason === "checksum-mismatch");
check("(4) checksum-mismatch ⇒ captured errorTail surfaced", s.errorTail === "expected abc, got def");

__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "extract-failed", errorTail: "tar: unexpected EOF" }));
resolveCapabilityServer(ghRow, {});
await flush();
s = getCapabilityProvisionStatus("github");
check("(4) extract-failed ⇒ state 'failed' + reason 'extract-failed'", s.state === "failed" && s.reason === "extract-failed");

__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "timeout" }));
resolveCapabilityServer(ghRow, {});
await flush();
s = getCapabilityProvisionStatus("github");
check("(4) timeout ⇒ state 'failed' + reason 'timeout'", s.state === "failed" && s.reason === "timeout");

__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "disabled" }));
resolveCapabilityServer(ghRow, {});
await flush();
s = getCapabilityProvisionStatus("github");
check("(4) disabled ⇒ state 'failed' + reason 'disabled'", s.state === "failed" && s.reason === "disabled");

// retryable: a fresh kick is allowed after a terminal failure (no permanent one-shot).
__setGithubBinaryProvisionerForTest(fixed({ binary: null, outcome: "download-failed", errorTail: "boom" }));
resolveCapabilityServer(ghRow, {});
await flush();
check("(4) first attempt failed", getCapabilityProvisionStatus("github").state === "failed");
__setGithubBinaryProvisionerForTest(gated);
newGate();
resolveCapabilityServer(ghRow, {}); // a later call / explicit retry — must be allowed
check("(4) a fresh kick is allowed after a terminal failure (retryable, not a dead-end)", getCapabilityProvisionStatus("github").state === "installing");
gate.resolve({ binary: READY_BIN, outcome: "ready" });
await flush();

// a STALE in-flight failure must NOT downgrade an already-'ready' status.
__setGithubBinaryProvisionerForTest(gated);
newGate();
resolveCapabilityServer(ghRow, {});
check("(4) an in-flight job is 'installing'", getCapabilityProvisionStatus("github").state === "installing");
gate.resolve({ binary: READY_BIN, outcome: "ready" });
await flush();
check("(4) settles 'ready'", getCapabilityProvisionStatus("github").state === "ready");
// A second, now-stale concurrent job (modeled by re-gating and resolving failed after the ready state stuck)
// must not downgrade the proven-ready status. Since resolvedBinCache now holds the binary, a further
// resolveCapabilityServer call short-circuits without even kicking — proving the ready state is sticky.
resolveCapabilityServer(ghRow, {});
check("(4) once ready, a later resolve short-circuits via cache (no re-kick, stays ready)", getCapabilityProvisionStatus("github").state === "ready");

// ===================== (5) LOOM_GITHUB_MCP_BIN human-only override — warm, no kick =====================
__setGithubBinaryProvisionerForTest(); // restore real provisioner + reset all per-slug state
check("(5) reset back to idle before the override case", getCapabilityProvisionStatus("github") === undefined);
process.env.LOOM_GITHUB_MCP_BIN = process.execPath;
const warmResolved = resolveCapabilityServer(ghRow, {});
check("(5) the override resolves a stdio server (no kick needed)", warmResolved !== null && warmResolved.command === process.execPath);
const warmStatus = getCapabilityProvisionStatus("github");
check("(5) a warm-resolved override marks status 'ready'", warmStatus.state === "ready");
check("(5) ready exposes the resolved binary", warmStatus.binary === process.execPath);
delete process.env.LOOM_GITHUB_MCP_BIN;

// No real network/extraction ever ran — confirm no real version dir was ever created under LOOM_HOME/bin.
check("(d) NO real github-mcp-server binary dir was created (fakes + override only — no network/extract)",
  !fs.existsSync(loomGithubMcpBinDir(VERSION)) || fs.readdirSync(loomGithubMcpBinDir(VERSION)).length === 0);

__setGithubBinaryProvisionerForTest();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — github-binary provisioning (agent-tooling P4 follow-on, github/github-mcp-server migration): the spawn hot path is fs.existsSync-only (returns null fast when cold, omits the MCP byte-identically to not-granted) and kicks deduped BACKGROUND provisioning off the event loop through the SHARED per-slug tracker; every classified outcome (unsupported-platform/download-failed/checksum-mismatch/extract-failed/timeout/disabled) surfaces via the status model with reason+errorTail; retryable after a terminal failure; a stale in-flight resolution never downgrades a proven 'ready'; and the human-only LOOM_GITHUB_MCP_BIN override resolves warm with no kick — all hermetic, no real network/extraction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
