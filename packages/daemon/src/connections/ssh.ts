/**
 * The in-daemon SSH exec core (agent-tooling epic a3d5c7f4, child 2 — `f6647205`): a thin `ssh2` wrapper
 * that runs exactly ONE command on a pinned host and returns its output. Takes PLAIN inputs — it is NOT
 * wired to the connection store or an MCP tool; the caller resolves the connection row, decrypts its key,
 * and enforces allowlist/read-only/audit policy before calling in here.
 */
// @decision a3d5c7f4 — never weaken host-key pinning (no TOFU), never request a PTY or agent/X11/port
// forward, never drop the connect+exec+read bound or the stdout/stderr caps, and never let ssh2's own
// error text (which could embed input) reach a thrown error, log line, or returned result.
import { createHash } from "node:crypto";
// `ssh2` is CJS; Node's cjs-module-lexer only manages to statically detect a PREFIX of its
// `module.exports = {...}` object literal (it bails once it hits a `key: require(...)` value, per
// `lib/index.js`) — `Client` happens to land before that bail point today, but relying on a named
// import here is fragile against an upstream reorder. Import the resolved default object and
// destructure instead, which reads the real object at runtime regardless of what the lexer saw.
import type { Socket } from "node:net";
import ssh2 from "ssh2";
const { Client } = ssh2;

/** OpenSSH's own `ssh-keygen -lf` / `ssh-keyscan` fingerprint format: `SHA256:<base64, no padding>` of a
 *  32-byte sha256 digest — 43 base64 characters, never padded. */
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/** Node's `setTimeout` silently CLAMPS any delay beyond the 32-bit signed int range
 *  (`2_147_483_647`ms, ~24.8 days) down to 1ms instead of throwing — so an unbounded `timeoutMs` could
 *  make a caller's "generous" bound actually resolve almost instantly instead of waiting at all. Shared
 *  ceiling for both timeouts in this file: no legitimate single `ssh_exec` call or host-key probe needs
 *  longer than 10 minutes. */
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;

/** The SHA256 host-key fingerprint of a raw public host key, in OpenSSH's own display format. Shared by
 *  the exec path's host-verifier below and by `fetchHostKeyFingerprint`, so a fingerprint captured by one
 *  is directly comparable to a fingerprint pinned via the other. */
export function computeHostKeyFingerprint(rawHostKey: Buffer): string {
  const digest = createHash("sha256").update(rawHostKey).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export interface SshExecInput {
  host: string;
  port: number;
  user: string;
  /** PEM/OpenSSH-format private key text. Passphrase-free (per the design decision record) — never
   *  supply a passphrase-protected key here; strip it before calling in. */
  privateKey: string;
  /** The host key fingerprint pinned at connection-create time, in `SHA256:<base64>` form. */
  expectedFingerprint: string;
  command: string;
  /** Bounds the whole connect+exec+read operation. */
  timeoutMs: number;
  /** Per-stream (stdout and stderr each, independently) byte cap. */
  maxOutputBytes: number;
}

export type SshExecResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number | null; truncated: boolean }
  | {
      ok: false;
      error: string;
      kind: "invalid-input" | "host-key-mismatch" | "timeout" | "connection-failed";
    };

function validateInput(input: SshExecInput): string | null {
  if (typeof input?.host !== "string" || !input.host) return "host is required";
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return "port must be an integer between 1 and 65535";
  }
  if (typeof input.user !== "string" || !input.user) return "user is required";
  if (typeof input.privateKey !== "string" || !input.privateKey) return "privateKey is required";
  if (typeof input.expectedFingerprint !== "string" || !FINGERPRINT_RE.test(input.expectedFingerprint)) {
    return "expectedFingerprint must be a SHA256:<base64> host-key fingerprint";
  }
  if (typeof input.command !== "string" || !input.command) return "command is required";
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMEOUT_MS) {
    return `timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}`;
  }
  if (!Number.isInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0) {
    return "maxOutputBytes must be a positive integer";
  }
  return null;
}

/** A byte cap can land mid-character on multi-byte UTF-8 content — `Buffer.toString("utf8")` would then
 *  decode the dangling lead/continuation bytes as a U+FFFD replacement character. Trim back to the last
 *  COMPLETE UTF-8 character boundary first (never decode a truncated sequence) by scanning up to 3 bytes
 *  from the end for a lead byte whose declared sequence length overruns what's left. */
function trimTrailingIncompleteUtf8(buf: Buffer): Buffer {
  const len = buf.length;
  for (let back = 1; back <= 3 && back <= len; back++) {
    const byte = buf.readUInt8(len - back);
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte — the lead byte is further back
    let seqLen = 1;
    if ((byte & 0xe0) === 0xc0) seqLen = 2;
    else if ((byte & 0xf0) === 0xe0) seqLen = 3;
    else if ((byte & 0xf8) === 0xf0) seqLen = 4;
    if (seqLen > back) return buf.subarray(0, len - back);
    break; // a complete sequence (or plain ASCII) ends exactly here — nothing to trim
  }
  return buf;
}

/** Collects stream chunks capped at `maxBytes` total — bytes beyond the cap are dropped (never
 *  buffered), and `truncated` flips the first time the cap is actually exceeded. Mirrors
 *  `boundedFetch.ts`'s own `readBoundedBody` shape: accumulate `Uint8Array` chunks, concat once at the
 *  end, rather than re-concatenating a growing `Buffer` on every chunk. */
function createCappedCollector(maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  return {
    push(chunk: Uint8Array): void {
      if (total >= maxBytes) {
        if (chunk.length > 0) truncated = true;
        return;
      }
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
      } else {
        chunks.push(chunk);
        total += chunk.length;
      }
    },
    get truncated(): boolean {
      return truncated;
    },
    toText(): string {
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      // Only trim when WE cut the stream short — untruncated output ending mid-character would be a
      // genuinely malformed remote command, not ours to silently repair.
      return (truncated ? trimTrailingIncompleteUtf8(buf) : buf).toString("utf8");
    },
  };
}

/**
 * ssh2@1.17.0's `Client.end()`/`destroy()` are both guarded by `isWritable(sock)` (`ssh2/lib/utils.js`):
 * once `end()` makes the socket non-writable, `destroy()` silently no-ops if the peer never closes its
 * side, leaving the real socket open. On EVERY pre-handshake timeout, ssh2's own internal `readyTimeout`
 * fires a LATE 'error' regardless of whether the socket was ever destroyed — so the two steps below guard
 * two DIFFERENT things. (1) The permanent no-op 'error' sink is the CRASH guard, load-bearing on every
 * settle: without it that late 'error' has no listener and crashes the daemon (`crashlog.ts`'s
 * `uncaughtException` handler calls `process.exit(1)`). (2) Destroying the REAL socket directly (bypassing
 * the `isWritable` guard) is the LEAK guard — `net.Socket.destroy()` emits 'close' ASYNCHRONOUSLY, so it
 * does not itself prevent the crash (1) already guards against; it just actually closes the socket instead
 * of leaving a live, half-closed handle open. Never revert to the guarded `client.destroy()` alone — it is
 * a no-op in exactly the case this exists for.
 */
function settleSsh2Client(client: InstanceType<typeof Client>): void {
  client.removeAllListeners();
  client.on("error", () => {
    /* ssh2's own post-settle teardown (e.g. a readyTimeout/keepalive firing after we've already
       resolved) lands here and is swallowed — never leave this client with zero 'error' listeners. */
  });
  try {
    client.end();
  } catch {
    /* already closing/closed */
  }
  const sock = (client as unknown as { _sock?: Socket })._sock;
  try {
    sock?.destroy();
  } catch {
    /* already destroyed */
  }
}

/**
 * Run exactly one command on a pinned SSH host. See the decision comment at the top of this file (id
 * a3d5c7f4) for the load-bearing invariants (no-TOFU host pinning, no PTY/forwarding, bounded, never
 * leaks the key).
 */
export async function runSshExecCommand(input: SshExecInput): Promise<SshExecResult> {
  const invalid = validateInput(input);
  if (invalid) return { ok: false, error: invalid, kind: "invalid-input" };

  return new Promise<SshExecResult>((resolve) => {
    const client = new Client();
    let settled = false;
    // @decision a3d5c7f4 — set synchronously, inside the host-verifier callback below, BEFORE ssh2's own
    // handshake teardown fires its 'error' event in the same call stack, so the no-TOFU host-key-pinning
    // refusal below can tell a real mismatch apart from any other connection error.
    let fingerprintMismatch = false;

    const timer = setTimeout(() => {
      finish({ ok: false, error: "ssh command timed out", kind: "timeout" });
    }, input.timeoutMs);

    function finish(result: SshExecResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleSsh2Client(client);
      resolve(result);
    }

    client.on("error", () => {
      // Never pass ssh2's own error text through (it could embed input). The specific, user-meaningful
      // cases (fingerprint mismatch, timeout) are classified from our own state, not from the library's
      // error message.
      if (fingerprintMismatch) {
        finish({ ok: false, error: "host key verification failed (fingerprint mismatch)", kind: "host-key-mismatch" });
        return;
      }
      finish({ ok: false, error: "ssh connection failed", kind: "connection-failed" });
    });

    client.on("ready", () => {
      // @decision a3d5c7f4 — no `pty`/`x11`/`agentForward` option is ever passed to `exec()` here, and
      // `connect()` below never sets `agentForward` either, so no PTY or agent/X11/port forwarding is
      // ever requested on this channel.
      client.exec(input.command, {}, (err, stream) => {
        if (err) {
          finish({ ok: false, error: "ssh command failed to start", kind: "connection-failed" });
          return;
        }
        const stdout = createCappedCollector(input.maxOutputBytes);
        const stderr = createCappedCollector(input.maxOutputBytes);

        stream.on("data", (chunk: Buffer) => stdout.push(chunk));
        stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        stream.on("close", (code: number | null) => {
          finish({
            ok: true,
            stdout: stdout.toText(),
            stderr: stderr.toText(),
            exitCode: code ?? null,
            truncated: stdout.truncated || stderr.truncated,
          });
        });
        stream.on("error", () => {
          finish({ ok: false, error: "ssh command stream error", kind: "connection-failed" });
        });
      });
    });

    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: input.user,
        privateKey: input.privateKey,
        // @decision a3d5c7f4 — pass explicitly so ssh2's own 20s default handshake bound never fires
        // first on a timeoutMs > 20000 and misclassifies a genuine stall as "connection-failed" instead
        // of "timeout" (our `timer` above, scheduled a tick earlier, still wins the race either way).
        readyTimeout: input.timeoutMs,
        hostVerifier: (key: Buffer) => {
          const fingerprint = computeHostKeyFingerprint(key);
          if (fingerprint !== input.expectedFingerprint) {
            fingerprintMismatch = true;
            return false;
          }
          return true;
        },
      });
    } catch {
      finish({ ok: false, error: "failed to establish ssh connection", kind: "connection-failed" });
    }
  });
}

export type FetchHostKeyFingerprintResult = { ok: true; fingerprint: string } | { ok: false; error: string };

const DEFAULT_FINGERPRINT_TIMEOUT_MS = 15_000;

/**
 * Human-initiated helper (never called from an agent-reachable path): connects just far enough to read
 * the host's public key, then DISPLAYS its fingerprint for the owner to confirm — it never pins
 * anything itself, and it never attempts authentication at all. Deliberately rejects in its own
 * host-verifier callback right after capturing the key — the same no-TOFU posture `runSshExecCommand`
 * enforces for a pinned connection, just applied to a probe instead: that aborts the handshake before
 * the auth phase would even begin, so no credential is needed to call this.
 */
export async function fetchHostKeyFingerprint(
  host: string,
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<FetchHostKeyFingerprintResult> {
  if (typeof host !== "string" || !host) return { ok: false, error: "host is required" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "port must be an integer between 1 and 65535" };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FINGERPRINT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, error: `timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}` };
  }

  return new Promise<FetchHostKeyFingerprintResult>((resolve) => {
    const client = new Client();
    let settled = false;
    let captured: string | undefined;

    const timer = setTimeout(() => {
      finish({ ok: false, error: "timed out waiting for the host key" });
    }, timeoutMs);

    function finish(result: FetchHostKeyFingerprintResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settleSsh2Client(client);
      resolve(result);
    }

    client.on("error", () => {
      finish(captured ? { ok: true, fingerprint: captured } : { ok: false, error: "failed to retrieve the host key" });
    });
    // In the unlikely case the handshake somehow completes despite the host-verifier's refusal below,
    // still resolve from whatever was captured rather than hanging until the timeout.
    client.on("ready", () => {
      finish(captured ? { ok: true, fingerprint: captured } : { ok: false, error: "failed to retrieve the host key" });
    });

    try {
      client.connect({
        host,
        port,
        username: "loom-fingerprint-probe",
        // Same reasoning as runSshExecCommand's connect() call above — keep ssh2's own handshake bound
        // from outliving ours when a caller passes a long opts.timeoutMs.
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => {
          captured = computeHostKeyFingerprint(key);
          return false;
        },
      });
    } catch {
      finish({ ok: false, error: "failed to connect to the host" });
    }
  });
}
