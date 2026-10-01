// Card d314f78d: runtime-unique-by-construction LOOM_PORT allocation for hermetic test files — the
// same "let something the OS guarantees is unique do the picking" principle _tmp-fixture.mjs's
// mkdtempManaged already uses for temp dirs, applied to the LOOM_PORT literal a hermetic test sets
// before requireHermeticEnv({port:true}) (see _guard.mjs).
//
// WHY: 43+ hermetic test files used to hand-pick a literal LOOM_PORT value, and duplicates across
// files were common (20 collision groups measured). hermeticPort() below derives a pid-based value
// instead so a same-value collision between two simultaneously-running hermetic test files is
// VANISHINGLY UNLIKELY RATHER THAN CERTAIN, unlike a fixed per-file literal.
//
// CORRECTION (card 3b4e2bbe): the header used to claim "none of these ports are ever bound". That was
// false — dev-proxy-loopback-nonregression.mjs (and the *-real-spawn.mjs family) DO call `.listen()`
// against a hermetic port, and hermeticPort()'s pid-derived value can land inside a Windows WinNAT/
// Hyper-V reserved range (`netsh interface ipv4 show excludedportrange protocol=tcp`), which refuses a
// real bind with `EACCES` — a pid-dependent, Windows-only flake observed redding a ~52-minute full gate
// (b801bad0's op 35e702a3). A file that genuinely BINDS a hermetic port must use `reserveHermeticPort`/
// `listenHermetic` below, never `hermeticPort()` directly — see each export's own doc comment.
import net from "node:net";

const PORT_RANGE_BASE = 40000; // clear of PROD_PORT (4317, see _guard.mjs) and any real dev port
const PORT_RANGE_SIZE = 20000; // stays well inside the valid 0-65535 port space

// Cosmetic-only LOOM_PORT value for a file that never binds a real listener (the overwhelming majority
// of hermeticPort() consumers — they only set LOOM_PORT so a value exists, or so an app.inject()-driven
// hermetic test's Host/Origin headers carry a non-prod-looking port; see project memory
// "gateway-hardening-tests-app-inject-port-cosmetic" for why that case is immune to any real collision).
// A file that calls `.listen()`/`.bind()` against this value is NOT covered by this function's safety
// property — use `reserveHermeticPort`/`listenHermetic` instead.
export function hermeticPort() {
  return PORT_RANGE_BASE + (process.pid % PORT_RANGE_SIZE);
}

// reserveHermeticPort: ask the OS for a genuinely free ephemeral port (bind a throwaway net.Server to
// port 0, read back whatever the OS assigned, release it) instead of guessing a number ourselves.
// Windows's own ephemeral-port allocator EXCLUDES its WinNAT/Hyper-V reserved ranges by construction —
// that is literally what `netsh interface ipv4 show excludedportrange` means — so a port the OS hands
// back for `:0` can never land inside one, unlike a pid-derived guess drawn from hermeticPort()'s fixed
// range. This is a STRUCTURAL fix for the EACCES class card 3b4e2bbe exists for, not a probability trick.
//
// RESIDUAL: there is a short release-to-rebind window between this probe closing and the caller's real
// bind, during which another process could in principle grab the same port — the same TOCTOU every
// "ask for :0, close, rebind" test helper accepts (the same `get-port`-style pattern used industry-wide).
// `listenHermetic` below retries through that window via EADDRINUSE.
export async function reserveHermeticPort(host = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

const LISTEN_MAX_ATTEMPTS = 5;

// listenHermetic: bind `app` (anything exposing an async Fastify-shaped `.listen({port,host})`) to a
// freshly `reserveHermeticPort`-ed port, retrying with a newly reserved port on EACCES/EADDRINUSE (the
// TOCTOU residual noted above — EACCES should no longer be reachable via reserveHermeticPort, but a
// defensive retry costs nothing). Sets `process.env.LOOM_PORT` to whichever port actually ends up bound
// and returns it.
//
// ORDERING TRAP: some daemon modules (pty/host.js, among others — see paths.ts's `PORT` constant) read
// `process.env.LOOM_PORT` ONCE at module import time, so this must be called BEFORE importing any such
// module, and nothing may import one between this call and it resolving. A caller that needs to
// construct one of those modules (e.g. a real PtyHost) before its server even exists — the *-real-
// spawn.mjs family — can't use this helper at the `.listen()` call site at all: it must call
// `reserveHermeticPort()` directly, set `LOOM_PORT` from it, and only THEN import the PORT-sensitive
// module, accepting the single-shot (no post-import retry) tradeoff that implies. See
// dev-proxy-loopback-nonregression.mjs (no such import ordering constraint — uses this helper directly)
// vs. disallow-harness-scheduling-tools-real-spawn.mjs / loom-home-write-deny-real-spawn.mjs (import
// PtyHost before their server is built — call `reserveHermeticPort()` directly instead).
export async function listenHermetic(app, { host = "127.0.0.1" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < LISTEN_MAX_ATTEMPTS; attempt++) {
    const port = await reserveHermeticPort(host);
    process.env.LOOM_PORT = String(port);
    try {
      await app.listen({ port, host });
      return port;
    } catch (e) {
      if (e?.code !== "EACCES" && e?.code !== "EADDRINUSE") throw e;
      lastErr = e;
      console.log(`[warn] listen(${port}) failed (${e.code}) — retrying with a freshly reserved port`);
    }
  }
  throw lastErr;
}
