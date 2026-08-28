import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Card `350bc307`: wire `codescapeUnclassifiedTools` (`pty/host.ts`) to the REAL mounted Codescape MCP
 * server, not just the two in-memory arrays it partitions. This is the live-introspection caller that
 * function's own doc pointed at — `nothing calls this automatically against the REAL mounted server
 * today`.
 *
 * Uses the SAME `@modelcontextprotocol/sdk` streamable-HTTP CLIENT class (already a daemon dependency —
 * it backs every `mcp/*.ts` SERVER this daemon runs) to speak the real MCP handshake (`initialize` then
 * `tools/list`) against a mounted Codescape entry (the same `/mcp/<codescapeId>` shape
 * `codescapeHttpMcpServer` in `pty/host.ts` builds, and the same shape a real `claude` spawn's own MCP
 * client talks to). This is deliberately NOT a hand-rolled single-shot POST — a prior fixture stand-in
 * (`fake-codescape-cli.mjs`'s `POST /mcp/*` route, used by `codescape-mcp-spawn.mjs`) explicitly
 * disclaims itself as "not a real MCP handshake"; speaking the protocol via the SDK is what makes this
 * probe trustworthy against whatever the peer's real server actually requires (session negotiation
 * included), without reading a line of their source.
 */
export interface AdvertisedToolsProbeResult {
  ok: boolean;
  /** Every tool name the server advertised, present iff `ok`. */
  tools?: string[];
  error?: string;
  /** True only when THIS probe's own `timeoutMs` bound elapsed before the round-trip finished — mirrors
   *  {@link CodescapeRequestResult.timedOut} in `supervisor.ts`: it tells "we stopped listening" apart
   *  from a genuine connection/protocol failure, never conflate the two. */
  timedOut?: boolean;
}

/**
 * One `initialize` + `tools/list` round-trip against `url` (a mounted Codescape entry). Async, bounded,
 * NEVER throws — mirrors `supervisor.ts`'s `runBounded`/`request` discipline: any failure (connection
 * refused, a timeout, a protocol error) resolves `{ok:false}` rather than rejecting. Opens a fresh
 * client per call and always closes it, even on failure — this is a periodic drift PROBE, never a held
 * connection, so it must not leak a socket/SSE stream across ticks.
 */
export async function probeAdvertisedTools(url: string, timeoutMs: number): Promise<AdvertisedToolsProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const client = new Client({ name: "loom-codescape-drift-probe", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport, { signal: controller.signal });
    const res = await client.listTools(undefined, { signal: controller.signal });
    return { ok: true, tools: res.tools.map((t) => t.name) };
  } catch (err) {
    return { ok: false, error: (err as Error).message, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {
      /* best-effort — the transport may already be dead (that's often WHY we're in this catch) */
    }
  }
}
