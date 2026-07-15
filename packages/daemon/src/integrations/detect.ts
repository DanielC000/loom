import net from "node:net";
import type { PlatformConfigOverride } from "@loom/shared";
import { openDesignMcpServer } from "../pty/host.js";
import { codescapeBinCandidate, hostToolBinExists } from "../paths.js";

/**
 * Card 8dc5ebb9: the live "is this configured host tool actually there" read the human-only
 * `/api/integrations` endpoint (gateway/server.ts) serves to the Settings › Integrations UI. `state` is
 * derived by calling the SAME resolver the real spawn path uses (openDesignMcpServer) or the same
 * bin-resolution precedence a spawn would use (codescapeBinCandidate/hostToolBinExists) — never a
 * re-derived fs check that could drift from actual spawn behavior.
 */
export type IntegrationSlug = "openDesign" | "codescape";
export type IntegrationSource = "db" | "env" | "none";
export type IntegrationState = "detected" | "not-found" | "unreachable";
export interface IntegrationStatus {
  slug: IntegrationSlug;
  label: string;
  /** The path currently effective (DB override, else env fallback, else null when neither is set — for
   *  codescape this can still resolve via a bare PATH-resolvable default even when `path` is null). */
  path: string | null;
  source: IntegrationSource;
  state: IntegrationState;
  /** A one-line human hint, present only when `state !== "detected"`. */
  detail?: string;
}

/**
 * OD's documented default local daemon port (github.com/nexu-io/open-design) — NOT verified against a
 * real install (none available in dev); this is best-effort feedback only, never load-bearing, so a wrong
 * port here is a trivial follow-up once a real OD instance is available to confirm/adjust against.
 */
const OD_DAEMON_PORT = 7456;
const OD_PROBE_TIMEOUT_MS = 400;

/** Bounded TCP-connect probe against 127.0.0.1:<port> — resolves true iff something answers within
 *  `timeoutMs`. Never throws; a refused/timed-out/errored connection all resolve false. ONLY ever called
 *  from this human-triggered REST detect read, never the synchronous spawn hot path (see
 *  openDesignMcpServer's doc for why a network probe has no place there). */
function probeTcp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function detectOpenDesign(override: PlatformConfigOverride, odDaemonPort: number): Promise<IntegrationStatus> {
  const dbPath = override.integrations?.openDesign?.path;
  const envPath = process.env.LOOM_OPEN_DESIGN_BIN;
  const path = dbPath?.trim() || envPath || null;
  const source: IntegrationSource = dbPath?.trim() ? "db" : envPath ? "env" : "none";
  const resolved = openDesignMcpServer(dbPath);
  if (!resolved) {
    return {
      slug: "openDesign", label: "Open Design", path, source, state: "not-found",
      detail: path ? "path set but not an existing absolute file" : "no path configured (Settings, or LOOM_OPEN_DESIGN_BIN)",
    };
  }
  const reachable = await probeTcp(odDaemonPort, OD_PROBE_TIMEOUT_MS);
  if (!reachable) {
    return {
      slug: "openDesign", label: "Open Design", path, source, state: "unreachable",
      detail: `binary found, but OD's own daemon (127.0.0.1:${odDaemonPort}, its documented default) didn't respond`,
    };
  }
  return { slug: "openDesign", label: "Open Design", path, source, state: "detected" };
}

function detectCodescape(override: PlatformConfigOverride): IntegrationStatus {
  const dbPath = override.integrations?.codescape?.path;
  const envPath = process.env.LOOM_CODESCAPE_BIN;
  const path = dbPath?.trim() || envPath || null;
  const source: IntegrationSource = dbPath?.trim() ? "db" : envPath ? "env" : "none";
  const bin = codescapeBinCandidate(dbPath);
  const detected = hostToolBinExists(bin);
  return {
    slug: "codescape", label: "Codescape", path, source,
    state: detected ? "detected" : "not-found",
    ...(detected ? {} : { detail: "binary not found on PATH or at the configured path" }),
  };
}

export interface DetectIntegrationsOpts {
  /** TEST SEAM ONLY: override OD's reachability-probe port. Production always uses OD_DAEMON_PORT (7456) —
   *  never pass this in real code, only from a hermetic test that needs a deterministically-closed port
   *  instead of gambling on 7456 being free on the host running the test. */
  odDaemonPort?: number;
}

/** Detect both known host-tool integrations against the daemon's current platform config override. */
export async function detectIntegrations(override: PlatformConfigOverride, opts?: DetectIntegrationsOpts): Promise<IntegrationStatus[]> {
  const odDaemonPort = opts?.odDaemonPort ?? OD_DAEMON_PORT;
  const [openDesign, codescape] = await Promise.all([
    detectOpenDesign(override, odDaemonPort),
    Promise.resolve(detectCodescape(override)),
  ]);
  return [openDesign, codescape];
}
