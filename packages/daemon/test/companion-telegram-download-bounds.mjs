// Card 731aa517 — companion/telegram.ts's `downloadAttachment` already had a timeout + a size cap, but
// used the bare default `fetch` with NO redirect policy (fetch's default redirect:"follow") — the bot
// token rides the download URL's PATH (not a header), so an auto-followed redirect could hand an
// attacker-controlled host a request carrying it. Now routed through the shared `guardedFetch`
// primitive (connections/boundedFetch.ts) with `redirect:"manual"`.
//
// The real download URL is hardcoded to api.telegram.org, so this test uses the `fetchImpl` seam to
// delegate to the REAL global `fetch` pointed at a local server instead (same init options —
// `redirect:"manual"`, the AbortSignal — pass straight through), so this still proves the real fetch
// engine honors the redirect/timeout guarantee end-to-end rather than a mock that could be told to.
//
// Against a REAL `http.createServer` on 127.0.0.1. No real network egress.
//
// Only case 1 below (redirect) is RED against the pre-fix `telegram.ts` (verified manually: revert
// telegram.ts + boundedFetch.ts to HEAD, rebuild, rerun — the redirect case fails because the pre-fix
// code auto-follows the 3xx and the attacker target IS hit). Cases 2 (hang) and 3 (oversized) were
// ALREADY bounded pre-fix (downloadAttachment already had a timeout + size cap before this card) — they
// are regression LOCKS, not discriminating RED proofs, and stay GREEN against both the pre-fix and
// fixed code.
//
// Run: 1) build, 2) node packages/daemon/scripts/test-daemon.mjs --only=companion-telegram-download-bounds
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1)
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const LOOM_HOME = useOwnLoomHome("loom-tg-dl-bounds-");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { createTelegramAdapter } = await import("../dist/companion/telegram.js");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

// Tripwire (card 731aa517 round 2): every case below deliberately ignores the real `_url` arg (which
// carries the real api.telegram.org host + the bot token) and redirects to a local test server instead —
// but that redirect lives in THIS test's `fetchImpl`, not in `downloadAttachment` itself. If a future
// edit to telegram.ts ever stopped threading `fetchImpl` into `guardedFetch`, this seam would silently go
// dark and the real global `fetch` would hit the real api.telegram.org with the real bot token — a
// dropped seam, not a passing test. Wrapping the global `fetch` to refuse any non-127.0.0.1 host turns
// that silent real-egress failure mode into an immediate FAILING one — but NOT a loud one (card
// 863d30c0): the thrown "HERMETIC TRIPWIRE: ..." message never reaches a log or assertion text. It's
// thrown from inside `guardedFetch`'s own `fetchImpl` call, so `guardedFetch`'s catch block (by design —
// see boundedFetch.ts's file-header guarantee 4) maps ANY thrown error to its fixed, URL-free "network
// error" text before telegram.ts ever sees the original message. A dropped seam still fails one of the
// cases below (e.g. 3a's "the log names the size cap" check, since the real download never happens), so
// the tripwire's safety property — this test cannot pass with the seam dropped — still holds; it just
// surfaces as a generic assertion failure rather than the tripwire's own diagnostic text.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const hostname = new URL(typeof url === "string" ? url : url.toString()).hostname;
  if (hostname !== "127.0.0.1") {
    throw new Error(`HERMETIC TRIPWIRE: refused a real fetch to non-127.0.0.1 host "${hostname}" — the fetchImpl seam was dropped`);
  }
  return realFetch(url, init);
};

const BOT_TOKEN = "123456:secret-bot-token-DO-NOT-LEAK";

function makeFakeBot(filePath) {
  return {
    api: {
      async sendMessage() { return {}; },
      async getFile() { return { file_path: filePath }; },
    },
    on() {},
    catch() {},
    async start() {},
    async stop() {},
    isRunning() { return false; },
  };
}

const servers = [];

try {
  // ============ 1 — redirect refused: the bot token (in the URL path) must NEVER reach the target =======
  {
    let attackerHits = 0;
    const attacker = http.createServer((req, res) => { attackerHits++; res.writeHead(200); res.end("ok"); });
    await listen(attacker);
    servers.push(attacker);
    const attackerUrl = `http://127.0.0.1:${attacker.address().port}/steal`;

    let dlHits = 0;
    const dlSrv = http.createServer((req, res) => { dlHits++; res.writeHead(302, { location: attackerUrl }); res.end(); });
    await listen(dlSrv);
    servers.push(dlSrv);
    const dlPort = dlSrv.address().port;

    const logs = [];
    const origError = console.error;
    console.error = (msg) => { logs.push(String(msg)); };
    let result;
    try {
      const adapter = createTelegramAdapter(BOT_TOKEN, () => {}, {
        bot: makeFakeBot("voice/file_1.oga"),
        fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${dlPort}/dl`, init),
      });
      result = await adapter.downloadAttachment({ type: "audio", fileId: "f1" });
    } finally {
      console.error = origError;
    }

    check("1a redirect: the download endpoint was actually hit (the setup is real)", dlHits === 1);
    check("1a redirect: the redirect target was NEVER hit — no auto-follow", attackerHits === 0);
    check("1a redirect: downloadAttachment returns null (clean failure, not a throw)", result === null);
    const logText = logs.join("\n");
    check("1a redirect: a DISTINCT, diagnosable redirect reason was logged with the status code", /refused a redirect.*302/i.test(logText));
    check("1a redirect: the log never names the redirect target host/port", !logText.includes(String(attacker.address().port)));
    check("1a redirect: the log never leaks the bot token", !logText.includes(BOT_TOKEN));
  }

  // ============ 2 — a hung download resolves bounded (never hangs the companion gateway) ================
  {
    const hangSrv = http.createServer(() => { /* never respond */ });
    await listen(hangSrv);
    servers.push(hangSrv);
    const hangPort = hangSrv.address().port;

    const logs = [];
    const origError = console.error;
    console.error = (msg) => { logs.push(String(msg)); };
    let result;
    const TEST_RACE_MS = 4000;
    const started = Date.now();
    try {
      const adapter = createTelegramAdapter(BOT_TOKEN, () => {}, {
        bot: makeFakeBot("voice/file_2.oga"),
        fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${hangPort}/dl`, init),
        downloadTimeoutMs: 250, // TEST override — short, so this doesn't wait out the real 60s bound.
      });
      const raced = await Promise.race([
        adapter.downloadAttachment({ type: "audio", fileId: "f2" }).then((v) => ({ raced: false, v })),
        new Promise((resolve) => setTimeout(() => resolve({ raced: true }), TEST_RACE_MS)),
      ]);
      result = raced;
    } finally {
      console.error = origError;
    }
    const elapsed = Date.now() - started;

    check("2a hang: resolves on its OWN timeout, not the test-level race (would be a hang pre-fix)", result.raced === false);
    check("2a hang: bounded by downloadTimeoutMs (well under the test's own generous ceiling)", elapsed < TEST_RACE_MS);
    check("2a hang: downloadAttachment returns null (clean failure, not a throw)", result.raced === false && result.v === null);
    const logText = logs.join("\n");
    check("2a hang: the log mentions the timeout", /timed out/i.test(logText));
  }

  // ============ 3 — an oversized attachment is capped WHILE STREAMING, partial file removed =============
  {
    const HUGE = Buffer.alloc(5000, "X");
    const oversizedSrv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "audio/ogg" });
      res.end(HUGE);
    });
    await listen(oversizedSrv);
    servers.push(oversizedSrv);
    const oversizedPort = oversizedSrv.address().port;

    const logs = [];
    const origError = console.error;
    console.error = (msg) => { logs.push(String(msg)); };
    let result;
    try {
      const adapter = createTelegramAdapter(BOT_TOKEN, () => {}, {
        bot: makeFakeBot("voice/file_3.oga"),
        fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${oversizedPort}/dl`, init),
        maxAudioBytes: 1000, // TEST override — far below HUGE, so this doesn't need a real 20MB probe.
      });
      result = await adapter.downloadAttachment({ type: "audio", fileId: "f3" });
    } finally {
      console.error = origError;
    }

    check("3a oversized: downloadAttachment returns null (clean failure, not a throw)", result === null);
    const logText = logs.join("\n");
    check("3a oversized: the log names the size cap", /exceeds the size cap/i.test(logText));
    // The partial file must not linger on disk after a capped download fails.
    const audioDir = path.join(LOOM_HOME, "tmp", "companion-audio");
    const leftover = fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [];
    check("3a oversized: no partial file left behind", leftover.length === 0);
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — companion/telegram.ts's downloadAttachment (via the shared guardedFetch primitive): a redirect from the download endpoint is NEVER auto-followed (the bot token proven to never reach a redirect target, against a real server), a hung download resolves within its own bound instead of hanging, and an oversized attachment is capped while streaming with the partial file cleaned up — each failure surfaces a distinct, diagnosable reason in the log."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (const s of servers) await close(s).catch(() => {});
  globalThis.fetch = realFetch;
}
await finishAndExit(failures === 0 ? 0 : 1);
