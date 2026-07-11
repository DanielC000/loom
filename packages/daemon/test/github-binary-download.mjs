import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// The REAL github-mcp-server download + checksum-verify + cross-platform-extract pipeline
// (capabilities/github-binary.ts) — per Loom's real-spawn doctrine, mocking the download/extraction is NOT
// acceptable for a supply-chain surface like this (a downloaded+executed binary); this test drives the
// ACTUAL fetch() download, the ACTUAL SHA256 verify, and the ACTUAL host-OS extraction (tar on posix,
// PowerShell Expand-Archive on win32) against a small fixture archive served from a real loopback
// http.createServer — no real network egress (a fixture asset, not the genuine GitHub release), but every
// byte of the download/verify/extract CODE PATH runs for real.
//
// The fixture archive's own SHA256 is injected as the "pinned" expected checksum for its asset name via
// __setGithubMcpChecksumOverrideForTest — the module's real (production) pinned constants for the genuine
// v1.5.0 release are never read or weakened by this override.
//
// Proves:
//   (a) a real download + checksum match + extraction lands the binary at loomGithubMcpBin(version); the
//       extracted file is executable and, when spawned, receives an env var (never argv) — the "env not
//       argv" proof this download pipeline itself must uphold (the credential-tie plumbing on TOP of this
//       resolved {command,args} entry is proven separately in github-capability.mjs).
//   (b) a corrupted archive (bytes that don't match the pinned checksum) ⇒ 'checksum-mismatch', and NO file
//       is ever extracted — the fail-closed verify-before-extract order (§3.4).
//   (c) CR finding #1 (atomic extraction): a payload whose checksum MATCHES (so verification passes) but
//       isn't a real archive ⇒ extraction itself fails ('extract-failed'), and NO partial/resolvable binary
//       is ever left at the final path — the extract-then-atomic-rename fix means a failed/interrupted
//       extraction can never leave the hot path's fs.existsSync check seeing a corrupt "ready" binary.
//
// Run: 1) build, 2) node test/github-binary-download.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ghdl-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.LOOM_HOME = tmpHome;
delete process.env.LOOM_GITHUB_MCP_NO_PROVISION; // exercise the REAL download/verify/extract path

const {
  ensureGithubMcpBinaryAsync, loomGithubMcpBin, loomGithubMcpBinDir, resolveGithubMcpAssetName, __setGithubMcpChecksumOverrideForTest,
} = await import("../dist/capabilities/github-binary.js");

const asset = resolveGithubMcpAssetName(process.platform, process.arch);
if (!asset) {
  console.log(`SKIP — unsupported test host platform/arch (${process.platform}/${process.arch}) for the github-binary download pipeline; nothing to exercise here.`);
  process.exit(0);
}
const isWin = process.platform === "win32";

// ===================== build a fixture archive containing a REAL, spawnable stub =====================
// posix: a shebang node script (chmod +x) IS directly executable — cheap, no giant binary copy needed.
// win32: Windows requires a genuine PE executable to spawn directly, so the stub is a COPY of node.exe
// itself (renamed to github-mcp-server.exe), invoked with a companion script path as an argv arg.
const work = path.join(tmpHome, "fixture-work");
const stubDir = path.join(work, "stub");
fs.mkdirSync(stubDir, { recursive: true });
const stubName = isWin ? "github-mcp-server.exe" : "github-mcp-server";
const stubPath = path.join(stubDir, stubName);
const echoScript = path.join(work, "echo.mjs");
fs.writeFileSync(echoScript, "console.log(JSON.stringify({argv:process.argv.slice(2), env:process.env}));\n");

if (isWin) {
  fs.copyFileSync(process.execPath, stubPath);
} else {
  fs.writeFileSync(stubPath, "#!/usr/bin/env node\nconsole.log(JSON.stringify({argv:process.argv.slice(2), env:process.env}));\n");
  fs.chmodSync(stubPath, 0o755);
}

const archivePath = path.join(work, asset);
if (isWin) {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Compress-Archive -Path $env:LOOM_GHDL_STUB -DestinationPath $env:LOOM_GHDL_ARCHIVE -Force"],
    { env: { ...process.env, LOOM_GHDL_STUB: stubPath, LOOM_GHDL_ARCHIVE: archivePath } });
} else {
  execFileSync("tar", ["-czf", archivePath, "-C", stubDir, stubName]);
}
check("fixture: the archive was built", fs.existsSync(archivePath));

const realSha256 = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");

// A payload that is NOT a valid archive but whose checksum we'll deliberately pin to match — proves that
// EXTRACTION (not verification) is what fails, and that a failed/interrupted extraction leaves no
// resolvable binary (the atomic-rename fix, CR finding #1).
const garbageBytes = Buffer.from("this checksum will be made to match, but tar/Expand-Archive cannot parse this as a real archive");
const garbageSha256 = crypto.createHash("sha256").update(garbageBytes).digest("hex");

// ===================== serve the fixture over a real loopback HTTP server =====================
const server = http.createServer((req, res) => {
  if (req.url === `/${asset}`) {
    res.writeHead(200);
    fs.createReadStream(archivePath).pipe(res);
  } else if (req.url === `/corrupt/${asset}`) {
    res.writeHead(200);
    res.end(Buffer.from("this is definitely not a valid archive — corrupted bytes"));
  } else if (req.url === `/badarchive/${asset}`) {
    res.writeHead(200);
    res.end(garbageBytes);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

__setGithubMcpChecksumOverrideForTest(asset, realSha256);

try {
  // ===================== (a) real download + checksum match + extraction =====================
  const version = "test-fixture-1.0.0";
  const result = await ensureGithubMcpBinaryAsync({ version, downloadBaseUrl: baseUrl, timeoutMs: 30_000 });
  check("(a) ensureGithubMcpBinaryAsync resolves 'ready'", result.outcome === "ready");
  check("(a) the resolved binary path matches loomGithubMcpBin(version)", result.binary === loomGithubMcpBin(version));
  check("(a) the file actually landed on disk", fs.existsSync(loomGithubMcpBin(version)));

  if (!isWin) {
    const mode = fs.statSync(loomGithubMcpBin(version)).mode;
    check("(a) posix: the extracted stub has the executable bit set (chmod 0o755 applied)", (mode & 0o100) !== 0);
  }

  const PAT_ENV_VAR = "GITHUB_PERSONAL_ACCESS_TOKEN";
  const PAT_VALUE = "ghp_test-stub-pat-do-not-leak";
  const runArgs = isWin ? [echoScript, "stdio"] : ["stdio"]; // posix stub ignores args; win32 stub IS node, needs a script to run
  const { stdout } = await execFileAsync(loomGithubMcpBin(version), runArgs, { env: { ...process.env, [PAT_ENV_VAR]: PAT_VALUE } });
  const parsed = JSON.parse(stdout);
  check("(a) the extracted stub, when spawned, receives the PAT via its OWN env", parsed.env[PAT_ENV_VAR] === PAT_VALUE);
  check("(a) the extracted stub's own argv does NOT carry the PAT (env-not-argv)", !JSON.stringify(parsed.argv).includes(PAT_VALUE));
  check("(a) the extracted stub's argv is exactly ['stdio'] (the real invocation contract)", JSON.stringify(parsed.argv) === JSON.stringify(["stdio"]));

  // ===================== (b) corrupted archive ⇒ checksum-mismatch, NO extraction =====================
  const corruptVersion = "test-fixture-1.0.0-corrupt";
  const corruptResult = await ensureGithubMcpBinaryAsync({ version: corruptVersion, downloadBaseUrl: `${baseUrl}/corrupt`, timeoutMs: 30_000 });
  check("(b) a corrupted download ⇒ outcome 'checksum-mismatch'", corruptResult.outcome === "checksum-mismatch");
  check("(b) checksum-mismatch resolves NO binary", corruptResult.binary === null);
  check("(b) checksum-mismatch's errorTail names the pinned (expected) hash", typeof corruptResult.errorTail === "string" && corruptResult.errorTail.includes(realSha256));
  check("(b) NO file was extracted for the corrupt version (fail-closed — never extract on mismatch)", !fs.existsSync(loomGithubMcpBin(corruptVersion)));

  // ===================== (c) checksum MATCHES but the payload isn't a real archive ⇒ extraction itself
  // fails, and the atomic-rename fix (CR finding #1) must leave NO resolvable (partial) binary behind =====
  __setGithubMcpChecksumOverrideForTest(asset, garbageSha256); // the checksum WILL pass — isolates the extraction failure
  const badArchiveVersion = "test-fixture-1.0.0-badarchive";
  const badArchiveResult = await ensureGithubMcpBinaryAsync({ version: badArchiveVersion, downloadBaseUrl: `${baseUrl}/badarchive`, timeoutMs: 30_000 });
  check("(c) checksum passes but a non-archive payload ⇒ outcome 'extract-failed'", badArchiveResult.outcome === "extract-failed");
  check("(c) extract-failed resolves NO binary", badArchiveResult.binary === null);
  check("(c) NO resolvable binary was left at the final path (the atomic rename never ran)", !fs.existsSync(loomGithubMcpBin(badArchiveVersion)));
  const badDestDir = loomGithubMcpBinDir(badArchiveVersion);
  const leftoverTmp = fs.existsSync(badDestDir) ? fs.readdirSync(badDestDir).filter((f) => f.endsWith(".tmp")) : [];
  check("(c) no leftover .tmp remnant in the destination dir (cleaned up on extraction failure)", leftoverTmp.length === 0);
} finally {
  __setGithubMcpChecksumOverrideForTest(asset, undefined);
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — github-binary REAL download + checksum-verify + cross-platform-extract pipeline: a genuine fetch() download + SHA256 verify + host-OS extraction (tar/Expand-Archive) lands an executable binary that transmits a secret via env-not-argv; a corrupted archive is REJECTED before extraction (fail-closed checksum-mismatch, no file ever lands); and a checksum-valid-but-non-archive payload fails extraction cleanly, with the atomic-rename fix leaving NO partial/resolvable binary or leftover temp file behind — real network (loopback fixture), real extraction, no mocks."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
