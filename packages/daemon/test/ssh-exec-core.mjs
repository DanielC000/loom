// Card f6647205 (epic a3d5c7f4, child 2) — the in-daemon SSH exec core (connections/ssh.ts).
// SECURITY-CRITICAL: NO real network, NO real host. Every scenario below runs against a THROWAWAY
// `ssh2.Server` bound to 127.0.0.1 with a THROWAWAY ed25519 host key, both generated inside this test
// process and used nowhere else — never ~/.ssh, never a real host — OR a plain `node:net` raw server
// (silent / SSH-ident-only) that never speaks SSH at all.
//
// Covers: happy path; fingerprint-mismatch refusal (server proves no session/exec request ever arrived);
// timeout; output-cap truncation (asserting what SURVIVES the cap, not merely that it fired, and that a
// multi-byte char cut mid-sequence by the cap is trimmed rather than decoded as U+FFFD); a server-side
// assertion that no pty/x11/agent-forward/tcpip-forward request ever arrives; malformed-key and
// auth-failure paths; a key-leak scan over every captured result + console output; fetchHostKeyFingerprint
// against the same throwaway server; and that a stalled/hung peer at any phase (pre-handshake, post-ready)
// never produces an uncaught 'error' or leaves a live socket handle.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/scripts/test-daemon.mjs --only=ssh-exec-core
import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1) — this module touches no Db/LOOM_HOME at all.
import net from "node:net";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Global stray-exception capture — installed BEFORE any risky scenario runs, so a stray 'error' event
// that ssh2 (or node's own net.Socket) emits with no listener attached (the CRITICAL #1 Code Review
// finding: an uncaughtException here crashes the whole daemon process via crashlog.ts's process.exit(1))
// is recorded instead of killing this test process outright. Checked at the very end of the file.
const strayExceptions = [];
process.on("uncaughtException", (err) => {
  strayExceptions.push({ kind: "uncaughtException", message: String(err?.message ?? err) });
});
process.on("unhandledRejection", (reason) => {
  strayExceptions.push({ kind: "unhandledRejection", message: String(reason?.message ?? reason) });
});

const { runSshExecCommand, fetchHostKeyFingerprint, computeHostKeyFingerprint, MAX_TIMEOUT_MS } = await import("../dist/connections/ssh.js");

// ============ fixture: a throwaway loopback ssh2.Server =================================================
const hostKeyPair = utils.generateKeyPairSync("ed25519");
const clientKeyPair = utils.generateKeyPairSync("ed25519");
const allowedPubKey = utils.parseKey(clientKeyPair.public);

// The fingerprint computed INDEPENDENTLY of fetchHostKeyFingerprint/runSshExecCommand's own host-verifier
// path — parsed straight from the generated host public key text, never from a value either function
// under test produced. Used as the pinned `expectedFingerprint` for every exec scenario below, so those
// scenarios never depend on fetchHostKeyFingerprint being correct.
const independentHostFingerprint = computeHostKeyFingerprint(utils.parseKey(hostKeyPair.public).getPublicSSH());

function startTestSshServer() {
  const flags = {
    ptyRequested: false,
    x11Requested: false,
    agentFwdRequested: false,
    tcpipRequested: false,
    globalRequests: [],
    // Non-vacuous proof that no exec request ever reached the server (MAJOR #2 Code Review finding):
    // `ptyRequested===false` alone is also true of a connection that never even opened a session, so a
    // refusal scenario that stops BEFORE the session stage looks identical to one that opens a session
    // but merely never asks for a pty. These two flip ONLY on a real session/exec arrival (see 1a below,
    // which proves both CAN flip) — a refusal scenario asserts both stay false instead.
    sessionOpened: false,
    execRequested: false,
  };
  const sockets = new Set();
  let lastReadySock = null; // the most recent connection's raw socket, captured once it reaches 'ready'

  const server = new Server({ hostKeys: [hostKeyPair.private] }, (conn) => {
    // A client-side abrupt close (e.g. our own runSshExecCommand destroying the socket on timeout, or
    // ssh2's own handshake teardown after a refused host-key verification) surfaces here as a benign,
    // EXPECTED connection-level error — without a listener, EventEmitter's default behavior is to throw
    // and crash this whole test process. Never a listener this test asserts behavior through.
    conn.on("error", () => {});
    conn.on("request", (accept, reject, name) => {
      flags.globalRequests.push(name);
      if (typeof reject === "function") reject();
    });
    conn.on("tcpip", (accept, reject) => {
      flags.tcpipRequested = true;
      if (typeof reject === "function") reject();
    });
    conn.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      if (ctx.key.algo !== allowedPubKey.type || Buffer.compare(ctx.key.data, allowedPubKey.getPublicSSH()) !== 0) {
        return ctx.reject(["publickey"]);
      }
      if (ctx.signature && allowedPubKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
        return ctx.reject(["publickey"]);
      }
      ctx.accept();
    });
    conn.on("ready", () => {
      lastReadySock = conn._sock;
      conn.on("session", (accept) => {
        flags.sessionOpened = true;
        const session = accept();
        session.on("pty", (accept2, reject2) => {
          flags.ptyRequested = true;
          if (typeof reject2 === "function") reject2();
        });
        session.on("x11", (accept2, reject2) => {
          flags.x11Requested = true;
          if (typeof reject2 === "function") reject2();
        });
        session.on("auth-agent", (accept2, reject2) => {
          flags.agentFwdRequested = true;
          if (typeof reject2 === "function") reject2();
        });
        session.once("exec", (accept2, reject2, info) => {
          flags.execRequested = true;
          const stream = accept2();
          if (info.command === "run:echo") {
            stream.write("stdout-line\n");
            stream.stderr.write("stderr-line\n");
            stream.exit(0);
            stream.end();
          } else if (info.command === "run:bigoutput") {
            stream.write(Buffer.alloc(20_000, "A"));
            stream.stderr.write(Buffer.alloc(20_000, "B"));
            stream.exit(3);
            stream.end();
          } else if (info.command === "run:multibyte") {
            // "A"*10 then "é" (U+00E9, 2 UTF-8 bytes: 0xC3 0xA9) then more "A"s — a maxOutputBytes of 11
            // lands exactly on the FIRST byte of "é", mid-character.
            stream.write(Buffer.from("A".repeat(10) + "é" + "A".repeat(10), "utf8"));
            stream.exit(0);
            stream.end();
          } else if (info.command === "run:hang") {
            // Deliberately never write/exit/end — the client-side timeout must be what ends this.
          } else if (info.command === "run:hangsilent") {
            // Same as run:hang, PLUS pause the raw socket (`net.Socket.pause()`, readStop() at the
            // libuv level) — the server stops reacting to ANYTHING further, including the client's own
            // DISCONNECT+FIN when its timeout fires, so the connection does NOT gracefully tear down on
            // its own (proven: pausing is what makes the post-ready CRITICAL #1 reproduction in test 3
            // actually possible — a plain run:hang peer reacts to our disconnect and closes cleanly).
            conn._sock.pause();
          } else {
            stream.exit(0);
            stream.end();
          }
        });
      });
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    flags,
    listen: () => new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    }),
    stop: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch { /* already gone */ } }
      server.close(() => resolve());
    }),
    // Forces a real TCP RST onto the one `run:hangsilent` connection's raw socket. A plain destroy() on
    // an UNPAUSED connection just produces a graceful mutual close (proven: the server reacts to the
    // client's own disconnect and both sides tear down cleanly — no error, nothing to reproduce);
    // `resetAndDestroy()` (Node >=16.17, sets SO_LINGER{on,0} then destroys) guarantees an actual RST
    // instead, which is what makes this reproduction possible at all on a PAUSED (run:hangsilent) socket.
    resetConnSocket: () => {
      try { lastReadySock?.resetAndDestroy(); } catch { /* already gone */ }
    },
  };
}

// A plain `node:net` server that never speaks SSH at all — the CRITICAL #1 Code Review reproduction: a
// stalled peer at the pre-handshake phase. "silent" accepts and says nothing; "ident-only" sends just the
// SSH ident line (what a real server sends first) and then goes silent before completing any key
// exchange — a different stall DEPTH, same "never reaches ready" shape.
function startRawServer(mode) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {}); // benign once our own client aborts/destroys its side
    if (mode === "ident-only") socket.write("SSH-2.0-OpenSSH_9.9\r\n");
  });
  return {
    listen: () => new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    }),
    stop: () => new Promise((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch { /* already gone */ } }
      server.close(() => resolve());
    }),
  };
}

// CRITICAL #1 proof helper: any active handle (process._getActiveHandles() — Node's own internal list of
// live Socket/Server/etc. handles keeping the event loop alive) whose CLIENT-side remote port matches one
// of our throwaway raw servers means the real underlying socket is still open — the exact leak
// settleSsh2Client's unconditional sock.destroy() exists to close.
function activeHandlesForPorts(ports) {
  return process._getActiveHandles().filter((h) => {
    try {
      return typeof h.remotePort === "number" && ports.includes(h.remotePort);
    } catch {
      return false;
    }
  });
}

// ============ key-leak scan setup =========================================================================
// Code Review round 2 #3: a FIXED base64-text slice (`body.slice(20,70)`) lands entirely inside the
// openssh-key-v1 container's own CONSTANT header — magic "openssh-key-v1\0", ciphername/kdfname "none",
// kdfoptions="", nkeys=1 — which is byte-for-byte IDENTICAL for every unencrypted ed25519 key, so that
// marker would "detect a leak" even for a key never used in this run. Locate the real, per-key 32-byte
// ed25519 seed instead by walking the actual wire format for real (every field below is read by its own
// length prefix, nothing assumed), then slice the ORIGINAL base64 TEXT starting at that seed's position —
// so a literal leak of the real base64 text (e.g. an echoed parser-error snippet) is still what this scan
// catches, just anchored on the bytes that actually vary per key.
function decodeOpenSshPrivateKeyBody(pemText) {
  return pemText.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
}
const OPENSSH_MAGIC = "openssh-key-v1\0";
function readUint32(buf, pos) { return { value: buf.readUInt32BE(pos), next: pos + 4 }; }
function readLenPrefixed(buf, pos) {
  const { value: len, next } = readUint32(buf, pos);
  return { value: buf.subarray(next, next + len), next: next + len };
}
// Byte offset, within the fully-decoded blob, of the real per-key 32-byte ed25519 private seed — the
// first byte that is NOT part of the constant container header or the (duplicated) public key.
function ed25519SeedByteOffset(raw) {
  let pos = OPENSSH_MAGIC.length;
  let r;
  r = readLenPrefixed(raw, pos); pos = r.next; // ciphername
  r = readLenPrefixed(raw, pos); pos = r.next; // kdfname
  r = readLenPrefixed(raw, pos); pos = r.next; // kdfoptions
  pos = readUint32(raw, pos).next; // nkeys
  r = readLenPrefixed(raw, pos); pos = r.next; // pubkey[0] wire blob
  pos = readUint32(raw, pos).next; // private-section length (cipher is "none", so cleartext follows)
  pos = readUint32(raw, pos).next; // checkint1
  pos = readUint32(raw, pos).next; // checkint2
  r = readLenPrefixed(raw, pos); pos = r.next; // keytype ("ssh-ed25519")
  r = readLenPrefixed(raw, pos); pos = r.next; // pubkey (duplicate)
  pos = readUint32(raw, pos).next; // length of (privkey-seed + pubkey), 64
  return pos; // the first byte of the 32-byte seed
}
function keyMarkerFor(privateKeyPem) {
  const body = decodeOpenSshPrivateKeyBody(privateKeyPem);
  const raw = Buffer.from(body, "base64");
  const seedByteOffset = ed25519SeedByteOffset(raw);
  const textOffset = Math.floor(seedByteOffset / 3) * 4;
  return body.slice(textOffset, textOffset + 50);
}

const KEY_MARKER = keyMarkerFor(clientKeyPair.private);
check("key-leak scan setup: marker is a real, non-trivial slice of the private key", KEY_MARKER.length >= 40);
check("key-leak scan setup: the marker is a real substring of its OWN key's base64 body", decodeOpenSshPrivateKeyBody(clientKeyPair.private).includes(KEY_MARKER));

// Self-test (Code Review round 2 #3): two INDEPENDENTLY generated ed25519 keys must give DIFFERENT
// markers — proves the marker tracks each key's own varying secret, not the constant container header
// every unencrypted ed25519 key shares (the old `slice(20,70)` would have given the SAME value for both).
const secondKeyPairForMarkerSelfTest = utils.generateKeyPairSync("ed25519");
const secondKeyMarker = keyMarkerFor(secondKeyPairForMarkerSelfTest.private);
check("key-leak scan setup self-test: two generated keys give DIFFERENT markers", secondKeyMarker !== KEY_MARKER);

// Positive control (proves the scan mechanism itself can fail, i.e. a real seed leak IS detected): a
// string that DOES contain the marker is detected, and a string that does NOT contain it is correctly
// reported absent.
check("key-leak scanner self-test: a planted marker occurrence IS detected", `noise-${KEY_MARKER}-noise`.includes(KEY_MARKER));
check("key-leak scanner self-test: unrelated text is correctly reported as NOT containing the marker", !"nothing-to-see-here".includes(KEY_MARKER));

const capturedResults = [];
let consoleBuf = "";
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
console.log = (...args) => { consoleBuf += args.map(String).join(" ") + "\n"; origLog(...args); };
console.error = (...args) => { consoleBuf += args.map(String).join(" ") + "\n"; origError(...args); };
console.warn = (...args) => { consoleBuf += args.map(String).join(" ") + "\n"; origWarn(...args); };

try {
  // ============ 1 — happy path ===========================================================================
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:echo",
      timeoutMs: 5000,
      maxOutputBytes: 1_000_000,
    });
    capturedResults.push(result);
    check("1a happy path: ok", result.ok === true);
    check("1a happy path: stdout", result.ok === true && result.stdout === "stdout-line\n");
    check("1a happy path: stderr", result.ok === true && result.stderr === "stderr-line\n");
    check("1a happy path: exitCode 0", result.ok === true && result.exitCode === 0);
    check("1a happy path: not truncated", result.ok === true && result.truncated === false);

    // --- 1b. server-side proof: no pty/x11/agent-forward/tcpip-forward request ever arrived ---
    check("1b no PTY requested", fixture.flags.ptyRequested === false);
    check("1b no X11 forwarding requested", fixture.flags.x11Requested === false);
    check("1b no agent forwarding requested", fixture.flags.agentFwdRequested === false);
    check("1b no tcpip (port) forwarding requested", fixture.flags.tcpipRequested === false);
    check("1b no global forward-shaped request arrived", !fixture.flags.globalRequests.some((n) => /forward/i.test(n)));
    // --- 1c. proof the sessionOpened/execRequested flags CAN flip positively (so a refusal scenario's
    // "stayed false" assertion below is non-vacuous, not just an always-false flag) ---
    check("1c session WAS opened on the real happy path", fixture.flags.sessionOpened === true);
    check("1c exec WAS requested on the real happy path", fixture.flags.execRequested === true);

    await fixture.stop();
  }

  // ============ 2 — fingerprint mismatch: refused, server proves no exec request arrived =================
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const wrongFingerprint = independentHostFingerprint.slice(0, -1) + (independentHostFingerprint.endsWith("A") ? "B" : "A");
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: wrongFingerprint,
      command: "run:echo",
      timeoutMs: 5000,
      maxOutputBytes: 1_000_000,
    });
    capturedResults.push(result);
    check("2a fingerprint mismatch: refused (not ok)", result.ok === false);
    check("2a fingerprint mismatch: kind is host-key-mismatch", result.ok === false && result.kind === "host-key-mismatch");
    // The server never even reached the session/exec stage — no command was ever requested. (MAJOR #2:
    // was asserted against the vacuous ptyRequested flag; sessionOpened/execRequested are proven able to
    // flip positively by 1c above, so this is a real, non-vacuous proof of refusal-before-session.)
    check("2b fingerprint mismatch: server never opened a session", fixture.flags.sessionOpened === false);
    check("2b fingerprint mismatch: server received no exec request", fixture.flags.execRequested === false);
    check("2b fingerprint mismatch: no PTY either, by the same token", fixture.flags.ptyRequested === false);

    await fixture.stop();
  }

  // ============ 3a — timeout: exec hangs, our own bound timer ends it ===================================
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const started = performance.now();
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:hang",
      timeoutMs: 800,
      maxOutputBytes: 1_000_000,
    });
    const elapsed = performance.now() - started;
    capturedResults.push(result);
    check("3a timeout: refused (not ok)", result.ok === false);
    check("3a timeout: kind is timeout", result.ok === false && result.kind === "timeout");
    check("3a timeout: resolved close to the configured timeoutMs, not instantly and not hung", elapsed >= 700 && elapsed < 8000);

    await fixture.stop();
  }

  // ============ 3b — CRITICAL #1 post-'ready' proof: a timeout while exec hangs, then ECONNRESET =======
  // A real handshake completes (unlike the pre-handshake raw-server scenarios in section 8 below), then
  // run:hangsilent PAUSES the server's raw socket right as exec is accepted — so when our own bound timer
  // fires and finish() tries to disconnect, the paused peer never reacts (proven: an UNPAUSED run:hang
  // peer gracefully tears down on its own the moment it receives our disconnect, leaving nothing to
  // reproduce — see run:hangsilent's own comment above). The connection is genuinely still open a moment
  // later, so forcing a real RST onto it now (resetConnSocket) lands on exactly the half-closed client
  // socket `finish()` left behind. Pre-fix (13e0b823): client.end() succeeds (writable, so not yet
  // guarded) and sends OUR OWN disconnect+FIN, but client.destroy() right after is a no-op (isWritable
  // is now false) — the socket is never actually destroyed. The RST then surfaces as a client-side socket
  // 'error' ("read ECONNRESET") with NO listener attached (client.removeAllListeners() ran with nothing
  // re-added) — an uncaught exception. Post-fix, settleSsh2Client already force-destroyed the real
  // socket, so there is nothing left for the RST to land on.
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:hangsilent",
      timeoutMs: 600,
      maxOutputBytes: 1_000_000,
    });
    capturedResults.push(result);
    check("3b post-ready hangsilent: still a plain timeout", result.ok === false && result.kind === "timeout");

    const strayBeforeReset = strayExceptions.length;
    await delay(400); // let finish()'s own end()/destroy() calls settle first.
    // Code Review round 2 #1 BLOCKING: proves the `_sock.destroy()` HALF of settleSsh2Client, not just the
    // error-sink half — without it (mutant B: destroy removed, error sink kept), the real client-side
    // socket for this port is still open here (the reviewer measured 1 live handle 2s after settle under
    // that mutant). Checked BEFORE resetConnSocket() below, so this is a leak proof, not a side effect of
    // the forced RST.
    check("3b post-ready hangsilent: no live client-side socket handle remains for this port before the forced RST", activeHandlesForPorts([port]).length === 0);
    fixture.resetConnSocket(); // force the real RST onto the still-open (paused) server-side socket.
    await delay(1000); // grace period for the client-side socket 'error' to surface, if one would.
    check("3b post-ready hangsilent + forced RST: no stray uncaught exception", strayExceptions.length === strayBeforeReset);

    await fixture.stop();
  }

  // ============ 4 — output-cap truncation: assert what SURVIVES, not merely that it fired ================
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const CAP = 100;
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:bigoutput",
      timeoutMs: 5000,
      maxOutputBytes: CAP,
    });
    capturedResults.push(result);
    check("4a output cap: ok (truncation is not a failure)", result.ok === true);
    check("4a output cap: truncated flag set", result.ok === true && result.truncated === true);
    check("4a output cap: stdout is capped at exactly maxOutputBytes", result.ok === true && result.stdout.length === CAP);
    check("4a output cap: stderr is capped at exactly maxOutputBytes", result.ok === true && result.stderr.length === CAP);
    check("4a output cap: the surviving stdout is a real prefix of what the server sent (not emptied)", result.ok === true && result.stdout === "A".repeat(CAP));
    check("4a output cap: the surviving stderr is a real prefix of what the server sent (not emptied)", result.ok === true && result.stderr === "B".repeat(CAP));
    // The command still ran to completion and its real exit code still comes back — truncation never
    // kills the channel early.
    check("4a output cap: real exit code still reported despite truncation", result.ok === true && result.exitCode === 3);

    await fixture.stop();
  }

  // ============ 4b — NIT #9: a multi-byte char cut mid-sequence by the cap is trimmed, never U+FFFD =====
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const CAP = 11; // "A"*10 (10 bytes) + the FIRST byte of "é"'s 2-byte UTF-8 sequence (0xC3) — incomplete.
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:multibyte",
      timeoutMs: 5000,
      maxOutputBytes: CAP,
    });
    capturedResults.push(result);
    check("4b multibyte boundary: ok (truncation is not a failure)", result.ok === true);
    check("4b multibyte boundary: truncated flag set", result.ok === true && result.truncated === true);
    check("4b multibyte boundary: never decodes the dangling lead byte as U+FFFD", result.ok === true && !result.stdout.includes("�"));
    check("4b multibyte boundary: trims back to the last COMPLETE character (the 10 'A's, not 11 bytes)", result.ok === true && result.stdout === "A".repeat(10));

    await fixture.stop();
  }

  // ============ 5 — fetchHostKeyFingerprint returns the server's real fingerprint ========================
  {
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const result = await fetchHostKeyFingerprint("127.0.0.1", port);
    capturedResults.push(result);
    check("5a fetchHostKeyFingerprint: ok", result.ok === true);
    check("5a fetchHostKeyFingerprint: matches the independently-computed fingerprint", result.ok === true && result.fingerprint === independentHostFingerprint);
    // Never pins/authenticates — the server never even saw a session/exec request from this probe.
    // (MAJOR #2: sessionOpened/execRequested, not the vacuous ptyRequested flag — see 1c above.)
    check("5b fetchHostKeyFingerprint: never opens a session", fixture.flags.sessionOpened === false);
    check("5b fetchHostKeyFingerprint: never requests exec", fixture.flags.execRequested === false);

    await fixture.stop();
  }

  // ============ 6 — invalid-input validation (no network call at all) ====================================
  {
    const result = await runSshExecCommand({
      host: "127.0.0.1",
      port: 0,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:echo",
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    capturedResults.push(result);
    check("6a invalid port: refused as invalid-input", result.ok === false && result.kind === "invalid-input");

    const result2 = await runSshExecCommand({
      host: "127.0.0.1",
      port: 22,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: "not-a-real-fingerprint",
      command: "run:echo",
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    capturedResults.push(result2);
    check("6b malformed expectedFingerprint: refused as invalid-input", result2.ok === false && result2.kind === "invalid-input");

    // 6c/6d — Code Review round 2 #7: bound BOTH timeouts against one sane ceiling. Node's `setTimeout`
    // silently CLAMPS any delay beyond the 32-bit signed int range to 1ms instead of throwing, so an
    // unbounded timeoutMs could make a caller's "generous" bound resolve almost instantly instead of
    // actually waiting — refused up front as invalid-input, never silently clamped.
    const result3 = await runSshExecCommand({
      host: "127.0.0.1",
      port: 22,
      user: "loom-test",
      privateKey: clientKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:echo",
      timeoutMs: MAX_TIMEOUT_MS + 1,
      maxOutputBytes: 1000,
    });
    capturedResults.push(result3);
    check("6c runSshExecCommand timeoutMs beyond the sane ceiling: refused as invalid-input", result3.ok === false && result3.kind === "invalid-input");

    const fpResult = await fetchHostKeyFingerprint("127.0.0.1", 22, { timeoutMs: MAX_TIMEOUT_MS + 1 });
    capturedResults.push(fpResult);
    check("6d fetchHostKeyFingerprint timeoutMs beyond the sane ceiling: refused, never silently clamped by Node to ~1ms", fpResult.ok === false);
  }

  // ============ 7 — MINOR #7: malformed-key and auth-failure paths ======================================
  {
    // 7a. malformed privateKey — a TRUNCATED copy of the REAL client key (still carrying most of its
    // real secret bytes), so this scenario genuinely probes "does a parse failure on the real key ever
    // echo it back" rather than testing against inert fabricated text. ssh2's own parseKey throws
    // SYNCHRONOUSLY inside connect(), before any socket is ever opened (see ssh2/lib/client.js's
    // `connect()`: parseKey runs well before the socket-connect block). Caught by our existing
    // try/catch, mapped to the fixed generic message — never ssh2's own `Cannot parse privateKey: ...`
    // text, which echoes back part of the parser's complaint. Pushed into capturedResults so the
    // end-of-file key-leak scan (section 9) covers this path too.
    const malformedKeyResult = await runSshExecCommand({
      host: "127.0.0.1",
      port: 1,
      user: "loom-test",
      privateKey: clientKeyPair.private.slice(0, -50),
      expectedFingerprint: independentHostFingerprint,
      command: "run:echo",
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    capturedResults.push(malformedKeyResult);
    check("7a malformed privateKey: refused as connection-failed", malformedKeyResult.ok === false && malformedKeyResult.kind === "connection-failed");
    check("7a malformed privateKey: generic error text, never ssh2's own parse-error message", malformedKeyResult.ok === false && !malformedKeyResult.error.toLowerCase().includes("parse"));

    // 7b. auth failure — a VALID-FORMAT key that simply isn't the one the server's allowedPubKey accepts
    // (the host-key check passes; authentication itself fails).
    const fixture = startTestSshServer();
    const port = await fixture.listen();
    const wrongKeyPair = utils.generateKeyPairSync("ed25519");
    const authFailResult = await runSshExecCommand({
      host: "127.0.0.1",
      port,
      user: "loom-test",
      privateKey: wrongKeyPair.private,
      expectedFingerprint: independentHostFingerprint,
      command: "run:echo",
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    capturedResults.push(authFailResult);
    check("7b auth failure: refused as connection-failed", authFailResult.ok === false && authFailResult.kind === "connection-failed");
    check("7b auth failure: server never opened a session", fixture.flags.sessionOpened === false);
    check("7b auth failure: server received no exec request", fixture.flags.execRequested === false);

    await fixture.stop();
  }

  // ============ 8 — a stalled pre-handshake peer never crashes the process or leaks a socket
  // @decision a3d5c7f4 — never restore the real ~21s unforced wait here: forcing a short internal
  // readyTimeout tests the error-sink crash guard alone, fast (8d below separately pins readyTimeout
  // forwarding). Both a fully silent peer and an ident-only one run against BOTH functions under test.
  {
    const rawSilent = startRawServer("silent");
    const rawIdentOnly = startRawServer("ident-only");
    const silentPort = await rawSilent.listen();
    const identPort = await rawIdentOnly.listen();
    const strayBeforeWave = strayExceptions.length;
    const SHORT_TIMEOUT = 500;
    const FORCED_INTERNAL_READY_TIMEOUT_MS = 900; // > SHORT_TIMEOUT, so it always fires AFTER our own settle.

    const originalConnectForSection8 = ssh2.Client.prototype.connect;
    ssh2.Client.prototype.connect = function forcedShortReadyTimeoutConnect(cfg, ...rest) {
      return originalConnectForSection8.call(this, { ...cfg, readyTimeout: FORCED_INTERNAL_READY_TIMEOUT_MS }, ...rest);
    };
    let execSilent, execIdent, fpSilent, fpIdent;
    try {
      [execSilent, execIdent, fpSilent, fpIdent] = await Promise.all([
        runSshExecCommand({ host: "127.0.0.1", port: silentPort, user: "loom-test", privateKey: clientKeyPair.private, expectedFingerprint: independentHostFingerprint, command: "run:echo", timeoutMs: SHORT_TIMEOUT, maxOutputBytes: 1000 }),
        runSshExecCommand({ host: "127.0.0.1", port: identPort, user: "loom-test", privateKey: clientKeyPair.private, expectedFingerprint: independentHostFingerprint, command: "run:echo", timeoutMs: SHORT_TIMEOUT, maxOutputBytes: 1000 }),
        fetchHostKeyFingerprint("127.0.0.1", silentPort, { timeoutMs: SHORT_TIMEOUT }),
        fetchHostKeyFingerprint("127.0.0.1", identPort, { timeoutMs: SHORT_TIMEOUT }),
      ]);
    } finally {
      ssh2.Client.prototype.connect = originalConnectForSection8;
    }
    capturedResults.push(execSilent, execIdent, fpSilent, fpIdent);

    check("8a raw silent server: runSshExecCommand times out (not hung)", execSilent.ok === false && execSilent.kind === "timeout");
    check("8a raw ident-only server: runSshExecCommand times out (not hung)", execIdent.ok === false && execIdent.kind === "timeout");
    check("8a raw silent server: fetchHostKeyFingerprint times out (not hung)", fpSilent.ok === false);
    check("8a raw ident-only server: fetchHostKeyFingerprint times out (not hung)", fpIdent.ok === false);

    await delay(300); // brief grace for the synchronous destroy inside finish() to fully propagate
    check("8b no live client-side socket handle remains open to either raw server", activeHandlesForPorts([silentPort, identPort]).length === 0);

    // The actual reproduction window: FORCED_INTERNAL_READY_TIMEOUT_MS fires ~400ms AFTER our own
    // SHORT_TIMEOUT settle — comfortably covered by this 1.2s wait, with margin for CI jitter.
    await delay(1200);
    check("8c no stray uncaught exception/rejection after ssh2's own (forced-short) internal readyTimeout fires post-settle", strayExceptions.length === strayBeforeWave);

    await rawSilent.stop();
    await rawIdentOnly.stop();
  }

  // ============ 8d — Code Review round 2 #4: PIN the readyTimeout fix itself, not just its race outcome.
  // Section 8 above (and item 6's own forced-short spy) deliberately makes the SINK the only thing under
  // test there — this section separately proves the real production code still forwards its OWN
  // `timeoutMs` as ssh2's `readyTimeout` on both call sites, so a future edit that silently drops that
  // forwarding (mutant C) is caught even though section 8 no longer would be. Wraps the SAME
  // `ssh2.Client.prototype.connect` (same module instance `dist/connections/ssh.js` imports) to RECORD,
  // never override, the `cfg.readyTimeout` actually passed.
  {
    const seenReadyTimeouts = [];
    const originalConnectForSection8d = ssh2.Client.prototype.connect;
    ssh2.Client.prototype.connect = function recordingConnect(cfg, ...rest) {
      seenReadyTimeouts.push(cfg?.readyTimeout);
      return originalConnectForSection8d.call(this, cfg, ...rest);
    };
    try {
      const fixture = startTestSshServer();
      const port = await fixture.listen();
      const execResult = await runSshExecCommand({
        host: "127.0.0.1", port, user: "loom-test", privateKey: clientKeyPair.private,
        expectedFingerprint: independentHostFingerprint, command: "run:echo", timeoutMs: 4242, maxOutputBytes: 1000,
      });
      capturedResults.push(execResult);
      const fpResult = await fetchHostKeyFingerprint("127.0.0.1", port, { timeoutMs: 3737 });
      capturedResults.push(fpResult);
      await fixture.stop();
    } finally {
      ssh2.Client.prototype.connect = originalConnectForSection8d;
    }
    check("8d runSshExecCommand forwards its own timeoutMs as ssh2's readyTimeout", seenReadyTimeouts[0] === 4242);
    check("8d fetchHostKeyFingerprint forwards its own timeoutMs as ssh2's readyTimeout", seenReadyTimeouts[1] === 3737);
  }
} finally {
  console.log = origLog;
  console.error = origError;
  console.warn = origWarn;
}

// ============ 9 — key-leak scan over every captured result + everything logged during the run ===========
// capturedResults now also covers the malformed-key (7a) and auth-failure (7b) paths, plus the
// pre-handshake timeout/CRITICAL #1 scenarios (8) — every result this file ever produced.
const serializedResults = JSON.stringify(capturedResults);
check("9a key-leak scan: the private key marker never appears in any returned result", !serializedResults.includes(KEY_MARKER));
check("9b key-leak scan: the private key marker never appears in anything logged during the run", !consoleBuf.includes(KEY_MARKER));
check("9c key-leak scan: the full private key string never appears in any returned result either", !serializedResults.includes(clientKeyPair.private));

console.log(failures === 0
  ? "\n✅ ALL PASS — runSshExecCommand/fetchHostKeyFingerprint: host-key pinning refuses on mismatch before any exec request, no PTY/forwarding is ever requested, timeouts and output caps behave, and the private key never appears in a result or log line."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
