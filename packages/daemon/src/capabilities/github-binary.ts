/**
 * Loom-managed provisioning for GitHub's maintained `github/github-mcp-server` — the replacement for the
 * archived `@modelcontextprotocol/server-github` (npx). Downloads a checksum-verified Go binary release
 * asset to `<LOOM_HOME>/bin/github-mcp-server/<version>/`, mirroring `python/venv.ts`'s event-loop
 * discipline: the spawn hot path only ever does a synchronous `fs.existsSync` (see `resolveGithubBinary`
 * in `registry.ts`); the download+verify+extract here runs OFF the event loop, in the BACKGROUND, kicked
 * by that resolver on a cold miss.
 *
 * SUPPLY-CHAIN (the trust anchor): {@link GITHUB_MCP_ASSET_CHECKSUMS} is a set of SHA256 constants PINNED
 * IN SOURCE from the v{@link GITHUB_MCP_SERVER_VERSION} release's own `checksums.txt` — not a
 * runtime-fetched checksums file (that would be TOFU, not a pin). Verify order is FAIL-CLOSED: download to
 * a temp file → hash the downloaded bytes → compare against the pinned constant → ONLY on an exact match
 * extract + chmod. Any mismatch deletes the temp download and returns `checksum-mismatch` WITHOUT
 * extracting or executing anything. Bumping the version updates the version constant AND this checksum map
 * in the SAME commit — the map IS the pin.
 *
 * The download itself is UNAUTHENTICATED (a public GitHub release asset) — the bound connection's PAT
 * flows only into the resolved MCP server's own env (see `resolveCapabilityServer`'s credential tie), never
 * into this download.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LOOM_HOME } from "../paths.js";

/** The pinned github/github-mcp-server release this build downloads. Bump alongside the checksum map below. */
export const GITHUB_MCP_SERVER_VERSION = "1.5.0";

/**
 * SHA256 of each supported platform/arch release asset for {@link GITHUB_MCP_SERVER_VERSION}, copied
 * verbatim from that release's own `github-mcp-server_${GITHUB_MCP_SERVER_VERSION}_checksums.txt` — the
 * ONLY trust anchor this module uses (never a runtime-fetched checksums file). Only the 6 platform/arch
 * combinations Loom supports are pinned (GoReleaser also publishes Linux/Windows `i386` assets Loom never
 * targets — see {@link GITHUB_MCP_PLATFORM_ASSET_MAP}).
 */
export const GITHUB_MCP_ASSET_CHECKSUMS: Readonly<Record<string, string>> = Object.freeze({
  "github-mcp-server_Darwin_arm64.tar.gz": "dcb2c448cec678027e0b727f5b4601f2775c9334e48fb80a3015b2db302de577",
  "github-mcp-server_Darwin_x86_64.tar.gz": "ce0027e65c55700c44f96da05a328236685a75ec0a8ec90ba4521fdaa6fd41a1",
  "github-mcp-server_Linux_arm64.tar.gz": "fc83c56f554969e9c1e554d2918bc48431d988d10238ef900c31c181c81da4b1",
  "github-mcp-server_Linux_x86_64.tar.gz": "7960747815e1fefab3e76494a26b6a270d5ec513c2132eb5e19656bb2218922b",
  "github-mcp-server_Windows_arm64.zip": "b1a8c5ae96cd0e0ae3329d10559908e5e340a74a35d1fa035207d6415f8d8bff",
  "github-mcp-server_Windows_x86_64.zip": "bf60a7468ba26eb589bc740fc78b1d2ab0d02b29e98cba0a6adfa3e38de58871",
});

/** node platform/arch → GoReleaser asset name (`github-mcp-server_[OS]_[ARCH].[ext]`). Windows ships `.zip`;
 *  everything else `.tar.gz`. Node's `x64` maps to GoReleaser's `x86_64`; `arm64` is spelled the same both sides. */
const GITHUB_MCP_PLATFORM_ASSET_MAP: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "github-mcp-server_Darwin_arm64.tar.gz",
  "darwin-x64": "github-mcp-server_Darwin_x86_64.tar.gz",
  "linux-arm64": "github-mcp-server_Linux_arm64.tar.gz",
  "linux-x64": "github-mcp-server_Linux_x86_64.tar.gz",
  "win32-arm64": "github-mcp-server_Windows_arm64.zip",
  "win32-x64": "github-mcp-server_Windows_x86_64.zip",
});

/** The release asset filename for a given platform/arch, or null when Loom doesn't support that combo
 *  (e.g. ia32) — PURE, platform-parameterized for testing (mirrors `loomVenvBin`). */
export function resolveGithubMcpAssetName(platform: NodeJS.Platform, arch: string): string | null {
  return GITHUB_MCP_PLATFORM_ASSET_MAP[`${platform}-${arch}`] ?? null;
}

/** TEST-ONLY: override (or clear, passing undefined) one asset's expected checksum — lets a test verify the
 *  REAL download+verify+extract pipeline against a fixture archive that isn't the genuine release binary,
 *  without weakening the pinned production checksums (which are never read through this override). */
const checksumOverrides = new Map<string, string>();
export function __setGithubMcpChecksumOverrideForTest(asset: string, sha256?: string): void {
  if (sha256 === undefined) checksumOverrides.delete(asset);
  else checksumOverrides.set(asset, sha256);
}
function expectedChecksumFor(asset: string): string | undefined {
  return checksumOverrides.get(asset) ?? GITHUB_MCP_ASSET_CHECKSUMS[asset];
}

/** `<LOOM_HOME>/bin/github-mcp-server/<version>/` — version-namespaced so a version bump lands in a FRESH
 *  dir (never overwritten in place). */
export function loomGithubMcpBinDir(version: string): string {
  return path.join(LOOM_HOME, "bin", "github-mcp-server", version);
}

/** The ABSOLUTE path to the extracted binary inside {@link loomGithubMcpBinDir} — `.exe` on win32, bare
 *  elsewhere. PURE (platform-parameterized for testing); does NOT touch the filesystem. */
export function loomGithubMcpBin(version: string, platform: NodeJS.Platform = process.platform): string {
  const dir = loomGithubMcpBinDir(version);
  return path.join(dir, platform === "win32" ? "github-mcp-server.exe" : "github-mcp-server");
}

/**
 * The classified outcome of a github-mcp-server provisioning attempt:
 *   - `ready`                — the binary resolved (already present, or after a fresh download+verify+extract);
 *   - `unsupported-platform` — this host's platform/arch has no pinned release asset;
 *   - `download-failed`      — the HTTP download failed (non-2xx, network error) — errorTail carries the reason;
 *   - `checksum-mismatch`    — the downloaded bytes' SHA256 didn't match the pinned constant (TERMINAL, never
 *                              silently retried with a relaxed check — the temp download is deleted, nothing
 *                              is extracted);
 *   - `extract-failed`       — the archive extraction (tar/Expand-Archive) failed or didn't produce the
 *                              expected binary;
 *   - `timeout`              — the download was killed by its bound;
 *   - `disabled`             — `LOOM_GITHUB_MCP_NO_PROVISION=1` (tests / ops): provisioning was not attempted.
 */
export type GithubBinaryProvisionOutcome =
  | "ready" | "unsupported-platform" | "download-failed" | "checksum-mismatch" | "extract-failed" | "timeout" | "disabled";

/** Structured result of {@link ensureGithubMcpBinaryAsync}: the resolved absolute binary path (or null) + why. */
export interface EnsureGithubBinaryResult {
  binary: string | null;
  outcome: GithubBinaryProvisionOutcome;
  errorTail?: string;
}

export interface EnsureGithubBinaryOpts {
  version: string;
  /** Bound (ms) for the download. Default {@link GITHUB_MCP_DOWNLOAD_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** TEST SEAM: override the release download base URL (mirrors `LOOM_MARKITDOWN_BIN`) — a fixture
   *  localhost server, never the real GitHub releases host, in a hermetic test. Defaults to the real
   *  `github/github-mcp-server` releases URL. */
  downloadBaseUrl?: string;
}

/** Bound (ms) for the release-asset download — the binary is small (tens of MB), so this is far smaller
 *  than markitdown's heavy pip-install bound, but still generous for a slow/corporate network. */
const GITHUB_MCP_DOWNLOAD_TIMEOUT_MS = 180_000;
/** Bound (ms) for archive extraction (tar/Expand-Archive) — fast, just unpacking one small binary. */
const GITHUB_MCP_EXTRACT_TIMEOUT_MS = 60_000;
/** Cap (bytes) on the captured stdout+stderr tail kept from a failed extraction, for diagnostics. */
const OUTPUT_TAIL_BYTES = 4096;

/** Run a child process to completion ASYNCHRONOUSLY, capturing a bounded stdout+stderr tail. NEVER rejects
 *  — a spawn error, non-zero exit, or timeout all resolve `ok:false` (mirrors `python/venv.ts`'s `runAsync`). */
function runChildAsync(command: string, args: string[], timeoutMs: number, extraEnv?: Record<string, string>): Promise<{ ok: boolean; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    const capture = (b: Buffer): void => {
      chunks.push(b);
      bytes += b.length;
      while (bytes > OUTPUT_TAIL_BYTES && chunks.length > 1) bytes -= chunks.shift()!.length;
    };
    const tail = (): string => {
      const s = Buffer.concat(chunks).toString("utf-8").trim();
      return s.length > OUTPUT_TAIL_BYTES ? s.slice(-OUTPUT_TAIL_BYTES) : s;
    };
    const finish = (ok: boolean): void => { if (!settled) { settled = true; resolve({ ok, timedOut, output: tail() }); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
    } catch {
      finish(false);
      return;
    }
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* noop */ } finish(false); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); finish(false); });
    child.on("exit", (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/** Download `url` to `destPath` via `fetch`, bounded by `timeoutMs` (AbortController). NEVER throws —
 *  resolves `{ok:false}` on any HTTP/network/timeout failure. */
async function downloadToFile(url: string, destPath: string, timeoutMs: number): Promise<{ ok: boolean; timedOut: boolean; errorTail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || !res.body) {
      return { ok: false, timedOut: false, errorTail: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), fs.createWriteStream(destPath));
    return { ok: true, timedOut: false };
  } catch (e) {
    return { ok: false, timedOut: controller.signal.aborted, errorTail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** SHA256 of a file's bytes, streamed (never loads the whole file into memory at once). */
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Extract the single `github-mcp-server`(.exe) entry from `archivePath` into `destDir` — ATOMICALLY (CR
 * finding #1): the binary is materialized into a TEMP sibling inside `destDir` first, then `fs.renameSync`'d
 * into its final path as the LAST step. Rename is atomic on the same filesystem, so the spawn hot path's
 * `fs.existsSync(finalBin)` (`resolveGithubBinary`, registry.ts) can only ever observe a FULLY-written
 * binary — never a partial one left by a crash or this function's own extract-timeout bound. Any failure
 * (extraction, copy, or the rename itself) cleans up the temp remnant and leaves NO resolvable binary at
 * the final path.
 *
 * POSIX: shells out to `tar` (the release asset is `.tar.gz`, archive root holds the bare binary +
 * LICENSE/README — extract ONLY the binary) into a throwaway scratch dir, then copies it into `destDir`'s
 * temp file (a plain copy, not a rename, since the scratch dir may be on a different filesystem than
 * `destDir` — cross-filesystem renames fail with EXDEV). Windows: the asset is `.zip`; Node has no built-in
 * zip reader, so this shells out to PowerShell's `Expand-Archive` (built into every supported Windows
 * version) into a scratch subdir — DELIBERATELY asymmetric with posix's single-member `tar` extract:
 * `Expand-Archive` unpacks the WHOLE archive there, and only the root `github-mcp-server.exe` is then
 * copied out. Safe either way — the scratch dir is throwaway (removed with the rest of the caller's tmpDir)
 * and the checksum verified BEFORE this function runs is the actual trust anchor, not the archive itself.
 * Paths are passed via env vars (not shell-interpolated) to sidestep PowerShell quoting/escaping concerns.
 * Both branches are HARDCODED commands (never archive-controlled input) run via `spawn` with no shell.
 */
async function extractGithubBinary(archivePath: string, destDir: string, platform: NodeJS.Platform): Promise<{ ok: boolean; errorTail?: string }> {
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = platform === "win32" ? "github-mcp-server.exe" : "github-mcp-server";
  const finalBin = path.join(destDir, finalName);
  // A random suffix avoids any collision with a concurrent/retried extraction of the same version — cheap
  // insurance on top of the per-slug provisioning dedupe (kickCapabilityProvision) that already prevents
  // concurrent extractions in the normal spawn path.
  const tmpBin = path.join(destDir, `.${finalName}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const cleanupTmp = (): void => { try { fs.rmSync(tmpBin, { force: true }); } catch { /* best-effort */ } };

  let extractedBin: string;
  if (platform === "win32") {
    const tmpExtractDir = path.join(path.dirname(archivePath), "extracted");
    const r = await runChildAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:LOOM_GHMCP_ARCHIVE -DestinationPath $env:LOOM_GHMCP_EXTRACT_DIR -Force"],
      GITHUB_MCP_EXTRACT_TIMEOUT_MS,
      { LOOM_GHMCP_ARCHIVE: archivePath, LOOM_GHMCP_EXTRACT_DIR: tmpExtractDir },
    );
    if (!r.ok) return { ok: false, errorTail: r.output || "Expand-Archive failed" };
    extractedBin = path.join(tmpExtractDir, "github-mcp-server.exe");
    if (!fs.existsSync(extractedBin)) return { ok: false, errorTail: "archive did not contain github-mcp-server.exe" };
  } else {
    const scratchDir = path.join(path.dirname(archivePath), "extract-scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const r = await runChildAsync("tar", ["-xzf", archivePath, "-C", scratchDir, "github-mcp-server"], GITHUB_MCP_EXTRACT_TIMEOUT_MS);
    if (!r.ok) return { ok: false, errorTail: r.output || "tar extraction failed" };
    extractedBin = path.join(scratchDir, "github-mcp-server");
    if (!fs.existsSync(extractedBin)) return { ok: false, errorTail: "archive did not contain github-mcp-server" };
  }

  try {
    fs.copyFileSync(extractedBin, tmpBin);
    if (platform !== "win32") fs.chmodSync(tmpBin, 0o755); // BEFORE the rename — the final path appears already-executable
    fs.renameSync(tmpBin, finalBin); // ATOMIC (same dir ⇒ same filesystem) — the LAST step
  } catch (e) {
    cleanupTmp();
    return { ok: false, errorTail: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true };
}

/**
 * THE reusable surface `resolveGithubBinary` (registry.ts) calls OFF the event-loop hot path (from a
 * background provisioning job) to resolve an ABSOLUTE path to the `github-mcp-server` binary — downloading,
 * checksum-verifying, and extracting it into the shared `<LOOM_HOME>/bin/github-mcp-server/<version>/` dir
 * on first use. Mirrors `ensurePythonPackageAsync`'s shape/discipline: ASYNC (never blocks), IDEMPOTENT
 * (a fast `fs.existsSync` short-circuit), BOUNDED (every network/child-process step has a timeout), and
 * NEVER THROWS — always resolves a CLASSIFIED {@link EnsureGithubBinaryResult}.
 *
 * Verify-before-extract (the supply-chain crux, §3.4): downloads to a TEMP file, computes its SHA256, and
 * compares against the PINNED {@link GITHUB_MCP_ASSET_CHECKSUMS} constant BEFORE any extraction — a
 * mismatch deletes the temp file and returns `checksum-mismatch` without ever extracting or executing the
 * downloaded bytes.
 *
 * TEST/ops seam: `LOOM_GITHUB_MCP_NO_PROVISION=1` makes this NEVER download/extract (only ever resolves an
 * already-present binary, else `disabled`) — mirrors `LOOM_PYTHON_NO_PROVISION`.
 */
export async function ensureGithubMcpBinaryAsync(opts: EnsureGithubBinaryOpts): Promise<EnsureGithubBinaryResult> {
  try {
    const bin = loomGithubMcpBin(opts.version);
    if (fs.existsSync(bin)) return { binary: bin, outcome: "ready" };
    if (process.env.LOOM_GITHUB_MCP_NO_PROVISION === "1") return { binary: null, outcome: "disabled" };

    const asset = resolveGithubMcpAssetName(process.platform, process.arch);
    if (!asset) return { binary: null, outcome: "unsupported-platform" };
    const expectedSha256 = expectedChecksumFor(asset);
    if (!expectedSha256) return { binary: null, outcome: "unsupported-platform" };

    const baseUrl = opts.downloadBaseUrl ?? `https://github.com/github/github-mcp-server/releases/download/v${opts.version}`;
    const url = `${baseUrl}/${asset}`;
    const timeoutMs = opts.timeoutMs ?? GITHUB_MCP_DOWNLOAD_TIMEOUT_MS;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ghmcp-"));
    try {
      const archivePath = path.join(tmpDir, asset);
      const dl = await downloadToFile(url, archivePath, timeoutMs);
      if (!dl.ok) return { binary: null, outcome: dl.timedOut ? "timeout" : "download-failed", errorTail: dl.errorTail };

      const actualSha256 = await sha256File(archivePath);
      if (actualSha256 !== expectedSha256) {
        // FAIL-CLOSED: do NOT extract. The tmpDir (and its unverified archive) is removed in the `finally` below.
        return { binary: null, outcome: "checksum-mismatch", errorTail: `expected ${expectedSha256}, got ${actualSha256}` };
      }

      const destDir = loomGithubMcpBinDir(opts.version);
      const ext = await extractGithubBinary(archivePath, destDir, process.platform);
      if (!ext.ok) return { binary: null, outcome: "extract-failed", errorTail: ext.errorTail };
      // extractGithubBinary already chmod'd (posix) + atomically renamed the binary into place — a
      // successful `ok:true` guarantees fs.existsSync(bin) here.
      return { binary: bin, outcome: "ready" };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  } catch (e) {
    return { binary: null, outcome: "extract-failed", errorTail: e instanceof Error ? e.message : String(e) };
  }
}
