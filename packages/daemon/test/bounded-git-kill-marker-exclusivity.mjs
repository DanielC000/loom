import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import { EventEmitter } from "node:events";
// Card 9f5ae011 (round 2) — `treeDeathConfirmed` (git/bounded.ts) is the new POSITIVE twin of
// `treeDeathUnconfirmed`: a caller gating a retry (or a leaked-lock removal) on "this kill was positively
// confirmed dead" must check it directly, never infer "confirmed" from `!treeDeathUnconfirmed(e)` — that
// negation also matches an unrelated non-kill failure, the exact over-broad gate this card's retry fix
// replaces. This file is the standing unit test the manager asked for: the two functions must be
// MUTUALLY EXCLUSIVE over every error shape either can observe.
//
// HERMETIC, no real git spawn: `withTimeoutKillingChild` is generic over any promise, so the real
// GIVE-UP path (a never-settling `p` + an inert AbortController) exercises the actual `markUnconfirmedKill`
// application inside bounded.ts itself — a REAL marker, not a message-shape stand-in — without needing a
// real child process. This file also verifies the MESSAGE-SHAPE fallback path (the one every gitFactory-
// seam test, including this card's own merge-confirm-verdict-cache-solo-merge-transient.mjs, actually
// exercises in practice, since the gitFactory seam bypasses the real kill machinery and its markers
// entirely).
//
// ROUND 3 (card 9f5ae011) adds [6]: the CONFIRMED marker's own real application site, inside
// `spawnCanonicalGitTree` itself — previously reachable only via a REAL kill (test/bounded-git-kill-on-
// timeout.mjs's [green] check, and the heavier merge-commit-kill-confirm.mjs/union-merge-kill-confirm.mjs
// real-spawn suites, both out of scope here per this task's HERMETIC-only, no-real-spawn directive) — now
// reachable hermetically too, via `spawnCanonicalGitTree`'s own `spawnImpl` test seam: a FAKE child whose
// `pid` is `null` takes the function's real unconditional-confirm branch with zero real OS process
// involved. Deleting `markConfirmedKill` from that branch turns this RED.
//
// ROUND 3 also adds [7]: a guard that simple-git's OWN bare, unwrapped `abortPlugin` message ("Abort
// signal received", no "(git child killed): " prefix, no marker) must never be classified as a confirmed
// kill by `treeDeathConfirmed`'s message-regex fallback.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/bounded-git-kill-marker-exclusivity.mjs
const { withTimeoutKillingChild, treeDeathConfirmed, treeDeathUnconfirmed, spawnCanonicalGitTree } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function assertMutuallyExclusive(label, e) {
  const confirmed = treeDeathConfirmed(e);
  const unconfirmed = treeDeathUnconfirmed(e);
  check(`[${label}] not BOTH confirmed and unconfirmed (confirmed=${confirmed}, unconfirmed=${unconfirmed})`,
    !(confirmed && unconfirmed));
  return { confirmed, unconfirmed };
}

try {
  // [1] REAL marker, hermetically reachable: a genuine give-up (PATH 2) rejection — no real child, no
  // real kill, just a never-settling promise racing withTimeoutKillingChild's own giveUpTimer. The
  // resulting error is tagged by bounded.ts's REAL `markUnconfirmedKill` call, not a message stand-in.
  {
    const neverSettles = new Promise(() => {});
    const inertController = new AbortController();
    let e = null;
    await withTimeoutKillingChild(neverSettles, 30, "exclusivity-give-up", inertController, 30).catch((err) => { e = err; });
    const { confirmed, unconfirmed } = assertMutuallyExclusive("give-up (real marker)", e);
    check("[give-up (real marker)] treeDeathUnconfirmed is true", unconfirmed === true);
    check("[give-up (real marker)] treeDeathConfirmed is false", confirmed === false);
  }

  // [2] Message-shape fallback — CONFIRMED shape (no marker): the exact string spawnCanonicalGitTree's
  // normal confirmed-kill path produces, wrapped by withTimeoutKillingChild's own "(git child killed)"
  // prefix (verified against test/bounded-git-kill-on-timeout.mjs's own [green] anchored assertion, and
  // against merge-confirm-verdict-cache-solo-merge-transient.mjs's fake-factory message). Driven through
  // the REAL withTimeoutKillingChild (a delayed-rejecting `p`, no marker attached) so the wrapped message
  // is produced by the real wrapping code, not hand-assembled here.
  {
    const rejectsPlain = new Promise((_resolve, reject) => { setTimeout(() => reject(new Error("Abort signal received")), 20); });
    const inertController = new AbortController();
    let e = null;
    await withTimeoutKillingChild(rejectsPlain, 5, "exclusivity-confirmed-shape", inertController, 5000).catch((err) => { e = err; });
    check("[confirmed-shape] wrapped message ends in the confirmed shape", /\(git child killed\): Abort signal received$/.test(e?.message ?? ""));
    const { confirmed, unconfirmed } = assertMutuallyExclusive("confirmed-shape (message fallback)", e);
    check("[confirmed-shape (message fallback)] treeDeathConfirmed is true", confirmed === true);
    check("[confirmed-shape (message fallback)] treeDeathUnconfirmed is false", unconfirmed === false);
  }

  // [3] Message-shape fallback — UNCONFIRMED-TREE shape (no marker): same idea, but with the trailing
  // "(process tree not fully confirmed dead)" suffix that must break the confirmed regex's `$` anchor.
  {
    const rejectsPlain = new Promise((_resolve, reject) => { setTimeout(() => reject(new Error("Abort signal received (process tree not fully confirmed dead)")), 20); });
    const inertController = new AbortController();
    let e = null;
    await withTimeoutKillingChild(rejectsPlain, 5, "exclusivity-unconfirmed-tree-shape", inertController, 5000).catch((err) => { e = err; });
    const { confirmed, unconfirmed } = assertMutuallyExclusive("unconfirmed-tree-shape (message fallback)", e);
    check("[unconfirmed-tree-shape (message fallback)] treeDeathUnconfirmed is true", unconfirmed === true);
    check("[unconfirmed-tree-shape (message fallback)] treeDeathConfirmed is false (the $ anchor must reject the trailing suffix)", confirmed === false);
  }

  // [4] A totally unrelated, non-kill-shaped failure — neither function may claim it. This is the exact
  // case the OLD over-broad retry gate ("not quarantined, not unconfirmed") wrongly treated as a
  // confirmed kill; both must read false here.
  {
    const e = new Error("fatal: bad revision 'HEAD'");
    const { confirmed, unconfirmed } = assertMutuallyExclusive("unrelated non-kill error", e);
    check("[unrelated non-kill error] treeDeathConfirmed is false", confirmed === false);
    check("[unrelated non-kill error] treeDeathUnconfirmed is false", unconfirmed === false);
  }

  // [5] The genuine give-up MESSAGE shape, manufactured directly (no marker) — belt-and-braces proof that
  // the message fallback alone (not just the real marker from [1]) also classifies give-up as unconfirmed,
  // never confirmed.
  {
    const e = new Error("git reset --hard (canonical) exceeded 500ms, killed, but did not die within 500ms — giving up (hung git child?)");
    const { confirmed, unconfirmed } = assertMutuallyExclusive("give-up shape (message fallback, no marker)", e);
    check("[give-up shape (message fallback, no marker)] treeDeathUnconfirmed is true", unconfirmed === true);
    check("[give-up shape (message fallback, no marker)] treeDeathConfirmed is false", confirmed === false);
  }

  // [6] ROUND 3 (card 9f5ae011): the REAL CONFIRMED_KILL marker application site, inside
  // `spawnCanonicalGitTree` itself — previously reachable only via a real kill. A FAKE spawnImpl returns a
  // bare EventEmitter standing in for a ChildProcess, `pid: null`, so the real function's own
  // unconditional-confirm branch fires (the same branch a real win32 close takes), with zero real OS
  // process involved and zero platform dependence. `capturedChild` lets the test drive the fake child's
  // `close` event by hand, in place of a real process actually exiting.
  {
    let capturedChild;
    const fakeSpawnImpl = () => {
      const child = new EventEmitter();
      child.pid = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      capturedChild = child;
      return child;
    };
    const controller = new AbortController();
    const { raw } = spawnCanonicalGitTree("/fake/repo", undefined, controller.signal, 1000, undefined, fakeSpawnImpl);
    const p = raw(["status"]);
    controller.abort(); // synchronously fires spawnCanonicalGitTree's own onAbort handler
    capturedChild.emit("close", null); // stand in for the (fake) child actually exiting
    let e = null;
    await p.catch((err) => { e = err; });
    check("[confirmed marker (real seam, no real spawn)] rejected", e !== null);
    const { confirmed, unconfirmed } = assertMutuallyExclusive("confirmed marker (real seam, no real spawn)", e);
    check("[confirmed marker (real seam, no real spawn)] treeDeathConfirmed is true — deleting markConfirmedKill from this branch must turn this RED", confirmed === true);
    check("[confirmed marker (real seam, no real spawn)] treeDeathUnconfirmed is false", unconfirmed === false);
  }

  // [7] ROUND 3 (card 9f5ae011): simple-git's OWN bare `abortPlugin` message — "Abort signal received",
  // with NO "(git child killed): " prefix and NO marker (verified against
  // node_modules/simple-git/dist/cjs/index.js's `abortPlugin`, which throws exactly this string on ANY
  // caller's own `abortSignal`-triggered abort, a far weaker event than this file's own kill-confirmation)
  // — must never be classified as a confirmed kill by `treeDeathConfirmed`'s message-regex fallback.
  {
    const e = new Error("Abort signal received");
    const { confirmed, unconfirmed } = assertMutuallyExclusive("bare simple-git abort message (no prefix, no marker)", e);
    check("[bare simple-git abort message] treeDeathConfirmed is false — the regex requires the (git child killed) prefix, not just the trailing text", confirmed === false);
    check("[bare simple-git abort message] treeDeathUnconfirmed is false", unconfirmed === false);
  }
} catch (e) {
  console.error("UNEXPECTED THROW:", e);
  failures++;
}

console.log(failures === 0
  ? "\n✅ ALL PASS — treeDeathConfirmed and treeDeathUnconfirmed are mutually exclusive across every real " +
    "and message-shape-fallback error shape exercised, including the real give-up marker path and the " +
    "exact unrelated-failure shape the pre-fix retry gate wrongly treated as a confirmed kill."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
