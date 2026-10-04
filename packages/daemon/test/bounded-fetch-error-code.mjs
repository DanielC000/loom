// Card 863d30c0 — `guardedFetch` (connections/boundedFetch.ts) built its "network error (CODE)" suffix
// from the top-level `err.code`. Node's real `fetch` (undici) never sets that — it throws a generic
// `TypeError: fetch failed` with `code: undefined`, and puts the REAL code (ECONNREFUSED, ERR_INVALID_URL,
// ...) on `err.cause.code`. So in production every network failure surfaced as a bare "network error",
// with no code at all. Fixed to also read `err.cause?.code`.
//
// Against a REAL closed loopback port (bind a free port, close it, fetch it) and a REAL malformed URL —
// no mock error shapes, no fetchImpl override: this proves what Node's actual fetch engine does, not what
// a hand-rolled test double is told to do.
//
// Case 1 (ECONNREFUSED) is RED against the pre-fix boundedFetch.ts (verified manually: revert
// boundedFetch.ts to HEAD, rebuild, rerun — the suffix is dropped entirely because the pre-fix code only
// ever reads `err.code`, which undici leaves undefined).
//
// Run: 1) build, 2) node packages/daemon/scripts/test-daemon.mjs --only=bounded-fetch-error-code
import net from "node:net";
import "./_guard.mjs"; // arms the Db prod-guard (LOOM_TEST=1)
import { finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { guardedFetch } = await import("../dist/connections/boundedFetch.js");

// ============ 1 — a real closed loopback port surfaces "(ECONNREFUSED)" ==============================
{
  // Bind a free port, then close it immediately — the port is now refused by the OS, guaranteed free of
  // any other listener (unlike picking an arbitrary fixed port, which could collide with something else
  // on the host).
  const probe = net.createServer();
  const port = await new Promise((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));

  const result = await guardedFetch(`http://127.0.0.1:${port}/x`, { timeoutMs: 5000 });

  check("1a closed port: guardedFetch fails (not ok)", result.ok === false);
  check("1a closed port: kind is network", result.ok === false && result.kind === "network");
  check("1a closed port: the error names the real cause code (ECONNREFUSED)", result.ok === false && result.error === "network error (ECONNREFUSED)");
}

// ============ 2 — a malformed URL surfaces its own cause code, never the host:port =====================
{
  const SECRET_HOST = "127.0.0.1:59999";
  // A raw space inside the URL fails fetch's own URL parsing before any network call is attempted —
  // undici's real fetch throws `TypeError: Failed to parse URL from <url>` at the top level (embedding
  // the URL verbatim) with `cause.code === "ERR_INVALID_URL"` and a `cause.message` that also embeds the
  // url/host — exactly the kind of detail card 731aa517 round 2 required stay out of this error.
  const malformedUrl = `http:// ${SECRET_HOST}/x`;

  const result = await guardedFetch(malformedUrl, { timeoutMs: 5000 });

  check("2a malformed URL: guardedFetch fails (not ok)", result.ok === false);
  check("2a malformed URL: the error names the real cause code (ERR_INVALID_URL)", result.ok === false && result.error === "network error (ERR_INVALID_URL)");
  check("2a malformed URL: the host:port never reaches the error text", result.ok === false && !result.error.includes(SECRET_HOST));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — guardedFetch's network-error mapping reads the real undici cause code (err.cause.code), never just the always-undefined top-level err.code, and never leaks cause.message's embedded host:port."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
