// Serializes concurrent `loom start --detach` / `daemon-supervisor.mjs --detach` launches against the
// SAME (LOOM_HOME, port) pair, using an OS-released primitive instead of a file-based lock.
//
// @decision 4e026f35 — no reclaim/staleness logic belongs in this file, on any platform; a macOS gap
// stays a documented residual, never a mutex.
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// LOOM_HOME may be spelled differently (a symlink, a relative path, differing case on win32, or — on
// win32 — an 8.3 short name like `LONGNA~1` alongside its long form) across two near-simultaneous
// invocations that are nonetheless targeting the SAME real directory — canonicalize so both resolve to
// the identical guard target. Handles a not-yet-existing home under a symlinked ancestor too — see the
// decision record's "Guard key derivation under a symlinked ancestor" section. Uses `realpathSync.native`
// rather than the plain `realpathSync`: the plain JS-land implementation does NOT expand an 8.3 short
// name (measured: it returns `LONGDI~1` byte-for-byte unchanged), so a short-named and long-named spelling
// of the SAME home would otherwise hash to two different guard keys; the native binding resolves both to
// the identical canonical long path (card d1c87a06).
// @decision 4e026f35
function canonicalLoomHome(loomHome) {
  const resolved = path.resolve(loomHome);
  let existing = resolved;
  const remaining = [];
  for (;;) {
    let real;
    try {
      real = fs.realpathSync.native(existing);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const parent = path.dirname(existing);
        if (parent === existing) break; // reached the filesystem root and even IT doesn't resolve — give up
        remaining.unshift(path.basename(existing));
        existing = parent;
        continue;
      }
      break; // some other error (permission, etc.) — fall back to the plain resolved path below
    }
    const full = remaining.length > 0 ? path.join(real, ...remaining) : real;
    return process.platform === "win32" ? full.toLowerCase() : full;
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function guardKey(loomHome, port) {
  const home = canonicalLoomHome(loomHome);
  return crypto.createHash("sha256").update(`${home}::${port}`).digest("hex").slice(0, 20);
}

// Returns the OS target string to `.listen()` on, or null when this platform has no OS-released primitive
// available (see the darwin/other branch in the module header) — null means "guard nothing, always succeed".
function guardTargetFor(platform, key) {
  if (platform === "win32") return `\\\\.\\pipe\\loom-start-${key}`;
  if (platform === "linux") return `\0loom-start-${key}`;
  return null;
}

const noopRelease = () => {};

/**
 * Acquire the OS-released start guard for (loomHome, port). See the module header for the mechanism and
 * its platform coverage.
 * @param {{ loomHome: string, port: number }} opts
 * @returns {Promise<{ acquired: boolean, release: () => void, code?: string, degraded?: boolean }>}
 *   - `acquired: true, release` — caller holds the guard; MUST call `release()` exactly once when done
 *     (idempotent — a second call is a harmless no-op). Even if `release()` is never reached (a crash),
 *     the OS reclaims the underlying handle the instant this process dies — see module header.
 *   - `acquired: false, code: "EADDRINUSE"` — another launcher already holds the guard for this EXACT
 *     (loomHome, port) pair, right now. Refuse: do not spawn. This is the ONLY `acquired:false` case.
 *   - `acquired: true, release, degraded: true, code` — a genuinely unexpected `.listen()` error that is
 *     NOT `EADDRINUSE` (e.g. an exotic sandbox/permission restriction). Fails OPEN rather than refusing:
 *     this guard is a safety net on top of behavior that already works without it (the daemon's own port
 *     bind already prevents two daemons from ever serving — card 4e026f35), so an obscure environmental
 *     quirk must never be able to brick an otherwise-legitimate single `loom start`. A caller may choose
 *     to log `code` for diagnostics; it must not treat this case as a refusal.
 */
export function acquireStartGuard({ loomHome, port }) {
  const target = guardTargetFor(process.platform, guardKey(loomHome, port));
  if (target === null) return Promise.resolve({ acquired: true, release: noopRelease });

  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    srv.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (err && err.code === "EADDRINUSE") { resolve({ acquired: false, code: "EADDRINUSE" }); return; }
      resolve({ acquired: true, release: noopRelease, code: err?.code, degraded: true });
    });
    srv.listen(target, () => {
      if (settled) return;
      settled = true;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { srv.close(); } catch { /* best-effort — the OS reclaims it on process exit regardless */ }
      };
      resolve({ acquired: true, release });
    });
  });
}
