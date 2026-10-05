// Card d56b12d8 round 2 (Code Review f53d7c8d, the Major, half (b)) — the edge the re-attach nonce bumps
// on, asserted directly against `src/lib/useCredentialReattach.ts`.
//
// WHY A UNIT TEST HERE AT ALL, given the e2e. `packages/web` has no React test harness (no jsdom, no
// testing-library), so `useCredentialReattachNonce` itself cannot be rendered and its bumps cannot be
// counted from here — which is exactly why the edge RULE was extracted into the pure `anyLockCleared`.
// The e2e (`e2e/terminal-loopback-lock-reattach.spec.ts`) proves the user-visible outcome, but it cannot
// isolate this half: with the Terminal reorder in place the loopback lock is never raised on a remote
// origin at all, so that spec would stay green even if the OR-collapse were restored here. The two fixes
// are independently sufficient for the OUTCOME and this is the only check that fails for half (b) alone.
//
// THE DEFECT. The edge was `was && !now` over a single collapsed `loopback !== null || gateway`. A
// clearing edge on ONE lock while the OTHER is still up leaves that OR true on both sides, so no bump was
// emitted — and both locks are module state surviving SPA navigation, with the loopback one having no
// clearing path at all on a remote origin. One wrong raise therefore disabled the other lock's recovery
// permanently, for the life of the document.
// Run: node --experimental-strip-types packages/web/test/credential-reattach-edge.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The module under test imports React. `anyLockCleared` is pure and touches none of it, but the import is
// evaluated regardless, and the extensionless relative imports its siblings use need the same loader hook
// every other test here registers — so the import below must be DYNAMIC (a static one would hoist above
// `register()`).
register("./_tsxLoaderHook.mjs", import.meta.url);
const { anyLockCleared } = await import("../src/lib/useCredentialReattach.ts");

let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`ok   ${name}`); };

const S = (loopback, gateway) => ({ loopback, gateway });

/** The OLD, defective rule, written out so each case below says what it would have answered. This is a
 *  NEGATIVE CONTROL, not a second implementation: without it "the new rule returns true" is just a
 *  restatement of the new rule, and says nothing about which inputs the fix actually changed. */
const orCollapsed = (was, now) => (was.loopback || was.gateway) && !(now.loopback || now.gateway);

check("the regression: the GATEWAY lock clearing under a stuck LOOPBACK lock IS an edge", () => {
  // THE CASE THE MAJOR IS ABOUT. A remote page whose terminal pane wrongly raised the loopback lock, then
  // a valid gateway paste: the only recovery for every bounded ladder in the app is this bump.
  const was = S(true, true);
  const now = S(true, false);
  assert.equal(anyLockCleared(was, now), true, "a gateway unlock must bump even while the loopback lock stays up");
  assert.equal(orCollapsed(was, now), false, "...and the OR-collapsed rule saw no edge here — the defect");
});

check("...and symmetrically, the LOOPBACK lock clearing under a stuck GATEWAY lock", () => {
  // The mirror case, asserted so the fix is a per-lock RULE rather than a special case bolted on for the
  // one direction the incident happened to arrive from.
  const was = S(true, true);
  const now = S(false, true);
  assert.equal(anyLockCleared(was, now), true);
  assert.equal(orCollapsed(was, now), false);
});

check("both locks clearing at once is ONE edge, not two", () => {
  // The nonce rebuilds each socket once per unlock; two simultaneous unlocks still need one rebuild. A
  // boolean return is what guarantees that — this pins the contract rather than the arithmetic.
  assert.equal(anyLockCleared(S(true, true), S(false, false)), true);
});

check("each lock clearing ALONE is an edge — the behaviour that must not regress", () => {
  // POLARITY CONTROL for the whole file: these are the only two cases the OLD rule got right, so a
  // "fix" that broke them would be a worse regression than the one being fixed. Both rules agree here.
  for (const [was, now] of [[S(true, false), S(false, false)], [S(false, true), S(false, false)]]) {
    assert.equal(anyLockCleared(was, now), true);
    assert.equal(orCollapsed(was, now), true, "the old rule handled the single-lock case correctly");
  }
});

check("a lock being SET is never an edge", () => {
  // Bumping on the lock going UP would tear a pane down mid-failure for no benefit — and would re-key the
  // attach effect at the exact moment the credential is known bad.
  assert.equal(anyLockCleared(S(false, false), S(true, false)), false);
  assert.equal(anyLockCleared(S(false, false), S(false, true)), false);
  assert.equal(anyLockCleared(S(false, false), S(true, true)), false);
  assert.equal(anyLockCleared(S(true, false), S(true, true)), false, "the other lock going up is not this lock clearing");
});

check("no change is never an edge, in any of the four states", () => {
  // Bumping on an unchanged observation would re-attach forever: the hook writes its `wasLocked` ref from
  // inside the effect, so a rule that fired on equality would re-run on every commit.
  for (const s of [S(false, false), S(true, false), S(false, true), S(true, true)]) {
    assert.equal(anyLockCleared(s, s), false, `unchanged ${JSON.stringify(s)} must not bump`);
  }
});

check("a SWAP — one lock clearing as the other is raised — is still an edge", () => {
  // Not a contrived case: a remote page's gateway banner paste clears the gateway lock, and an unrelated
  // write 401 can raise the loopback one in the same commit. The pane whose credential just became valid
  // must still re-attach; collapsing to a count of raised locks (1 before, 1 after) would miss it, which
  // is the same class of mistake as the OR.
  assert.equal(anyLockCleared(S(false, true), S(true, false)), true);
  assert.equal(anyLockCleared(S(true, false), S(false, true)), true);
  assert.equal(orCollapsed(S(false, true), S(true, false)), false, "the old rule missed this one too");
});

check("the hook's own effect deps pin EACH lock separately — never collapsed into one OR'd dependency", () => {
  // THE GAP THIS CLOSES. Every check above pins the ALGEBRA of `anyLockCleared` against the inputs it's
  // given — none of them can see whether `useCredentialReattachNonce`'s effect actually feeds it a
  // per-lock edge at RUNTIME, because `packages/web` has no React test harness to render the hook. A
  // worker could revert the deps array to the pre-fix `[locks.loopback || locks.gateway]` and every check
  // above would still pass — the effect would just never RE-RUN on the edge the algebra correctly
  // classifies, since a single OR-ed dependency doesn't change value across the case the file's own
  // header calls load-bearing (@decision d56b12d8). This is a source-text assertion for exactly that half.
  const srcPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "useCredentialReattach.ts");
  const raw = readFileSync(srcPath, "utf8");
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const match = stripped.match(/\}, \[([^\]]*)\]\);/);
  assert.ok(match, "could not find the hook's effect dependency array in useCredentialReattach.ts");
  const deps = match[1].replace(/\s+/g, "");
  // NEGATIVE CONTROL: reverting the deps array to `[locks.loopback || locks.gateway]` must fail this
  // exact assertion. Measured — `deps` for that revert is "locks.loopback||locks.gateway", which does not
  // equal the pinned string below, so the assertion goes RED under it (checked by temporarily applying
  // that revert and re-running this file; restored before committing).
  assert.equal(deps, "locks.loopback,locks.gateway",
    "the effect must depend on EACH lock separately (`[locks.loopback, locks.gateway]`) — a collapsed "
    + "`locks.loopback || locks.gateway` dependency cannot see one lock's clearing edge while the other "
    + `stays up, which is the exact regression this file exists to catch. Saw deps: ${JSON.stringify(match[1])}`);
});

console.log(`\n${pass} checks passed`);
