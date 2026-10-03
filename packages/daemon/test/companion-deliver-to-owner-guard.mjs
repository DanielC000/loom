import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan, no Db used
// Card b343c5f0 round 2, delta Code Review `bdb48960` (finding 1). `GrantOutbound.deliverToOwner` returns
// `boolean | "timeout"` — and `"timeout"` is TRUTHY in JS, so a lever that wrote `if (delivered)`/
// `if (!delivered)` instead of going through the shared `deliverToOwnerError()` chokepoint (capabilities.ts
// ~355) would silently fail OPEN on a timeout (treat it as a confirmed propose) or silently swallow a
// legitimate propose (treat a timeout as a hard failure) — depending on which way the inline check leaned.
// Every one of the eight propose-sites was hand-written to go through the chokepoint instead, but nothing
// mechanical enforced that invariant — this file is that mechanism.
//
// MECHANISM (pure source-text scan of packages/daemon/src/companion/capabilities.ts, comment-stripped,
// no dist/no Db):
//   1. Find every `const/let X = await ....deliverToOwner(` call site (today: 8).
//   2. For each site, take the WINDOW of text from right after that assignment line up to the next site
//      (or a bounded lookahead) and require, in order:
//        a. a `deliverToOwnerError(X)` call — the EXACT captured variable, not some other name;
//        b. its result captured into a local `const/let E = deliverToOwnerError(X)`;
//        c. an `if (E) return ...` early-return gate;
//        d. that gate (and the `deliverToOwnerError(` call) appears BEFORE any `pending*.set(` in the
//           same window — a lever that records pending state before (or without) the gate is exactly the
//           bug class this guards against;
//        e. NO direct truthiness check on X anywhere in the window (`if (X)`, `if (!X)`, `X === true`) —
//           the latent trap named above, forbidden even if a (conforming) chokepoint call is ALSO present.
//   3. A `.deliverToOwner(` call whose result is never captured into a local (e.g. `if (await
//      ...deliverToOwner(...))`) is flagged outright — there's no variable to gate through the chokepoint,
//      so the only way to branch on it directly is the forbidden truthiness check.
//
// WHY COMMENT-STRIPPED SOURCE IS SAFE TO READ RAW (never folded into CHANGED_TS_TEXT_SCANNER_REPO_PATHS,
// packages/daemon/src/git/worktrees.ts — immunity shape (3) in that list's own doc): this file calls the
// shared `stripComments()` helper before every scan, same posture as mcp-project-fields-chokepoint-guard.mjs
// and project-response-redaction-drift-guard.mjs — a comment-only diff can never flip this guard's verdict.
//
// ⚠ HONEST LIMITS: textual, not a type-checker. Per-site windows are bounded (800 chars or the next site,
// whichever is smaller) — sufficient for this corpus's own 2-4-line gate blocks (measured), not a claim
// about an arbitrarily large lever body. A chokepoint call separated from its pending*.set( by more than
// the window would be invisible to this scan; none of the 8 real sites are anywhere close to that.
//
// Run: node packages/daemon/test/companion-deliver-to-owner-guard.mjs (no build needed — pure source-text
// scan, mirrors mcp-project-fields-chokepoint-guard.mjs's own no-dist-dependency posture)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_FILE = path.resolve(__dirname, "..", "src", "companion", "capabilities.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const DELIVER_CALL_RE = /\.deliverToOwner\(/g;
const ASSIGN_RE = /(?:const|let)\s+(\w+)\s*=\s*await\s+[\w.]+\.deliverToOwner\(/g;
const WINDOW_MAX = 800;

/**
 * Scan comment-stripped source TEXT for every `deliverToOwner(` call site and verify each is gated
 * through `deliverToOwnerError(` — with the exact assigned variable, captured into a local, early-returned
 * BEFORE any `pending*.set(` — and that no direct truthiness check on the raw tri-state value exists
 * anywhere nearby. See header for the full rule. Pure function so the fixture section below can probe it
 * against synthetic bodies independent of the real file's current (evolving) shape.
 */
function scanDeliverToOwnerSites(stripped) {
  const rawCallIndices = [];
  {
    let m;
    DELIVER_CALL_RE.lastIndex = 0;
    while ((m = DELIVER_CALL_RE.exec(stripped)) !== null) rawCallIndices.push(m.index);
  }

  const sites = [];
  {
    let m;
    ASSIGN_RE.lastIndex = 0;
    while ((m = ASSIGN_RE.exec(stripped)) !== null) sites.push({ varName: m[1], index: m.index });
  }

  const results = sites.map((site, i) => {
    const lineEnd = stripped.indexOf("\n", site.index);
    const windowStart = lineEnd === -1 ? site.index : lineEnd + 1;
    const nextSiteIndex = i + 1 < sites.length ? sites[i + 1].index : stripped.length;
    const windowEnd = Math.min(windowStart + WINDOW_MAX, nextSiteIndex);
    const window = stripped.slice(windowStart, windowEnd);

    const reasons = [];
    const v = site.varName;

    // (e) forbidden direct truthiness check — the latent trap. Checked FIRST and unconditionally: even a
    // window that also has a conforming chokepoint call must not ALSO carry a hand-rolled shortcut.
    const forbiddenRe = new RegExp(`if\\s*\\(\\s*!?\\s*\\b${v}\\b\\s*\\)|\\b${v}\\b\\s*===\\s*true`);
    if (forbiddenRe.test(window)) {
      reasons.push(`a direct truthiness check on '${v}' (if(${v})/if(!${v})/${v}===true) — "timeout" is truthy, this is the latent trap`);
    }

    // (a)/(b) the chokepoint call, with the exact variable, captured into a local.
    const errCallRe = /deliverToOwnerError\(\s*(\w+)\s*\)/;
    const errCallMatch = errCallRe.exec(window);
    let errVarName = null;
    if (!errCallMatch) {
      reasons.push("no deliverToOwnerError( call found before the next pending*.set( / lever boundary");
    } else if (errCallMatch[1] !== v) {
      reasons.push(`deliverToOwnerError( called with '${errCallMatch[1]}', not the captured delivery result '${v}'`);
    } else {
      const errVarAssignRe = /(?:const|let)\s+(\w+)\s*=\s*deliverToOwnerError\(/;
      const errVarAssignMatch = errVarAssignRe.exec(window);
      if (!errVarAssignMatch) reasons.push("deliverToOwnerError(...) result is not captured into a local const/let");
      else errVarName = errVarAssignMatch[1];
    }

    // (d) ordering against pending*.set(
    const pendingRe = /pending\w*\.set\(/;
    const pendingMatch = pendingRe.exec(window);

    if (errCallMatch && pendingMatch && errCallMatch.index >= pendingMatch.index) {
      reasons.push("pending*.set( appears before (or at) the deliverToOwnerError( gate");
    }

    // (c) the early-return gate, and its own ordering against pending*.set(
    if (errVarName) {
      const guardRe = new RegExp(`if\\s*\\(\\s*\\b${errVarName}\\b\\s*\\)\\s*return\\b`);
      const guardMatch = guardRe.exec(window);
      if (!guardMatch) reasons.push(`no 'if (${errVarName}) return ...' early-return gate found`);
      else if (pendingMatch && guardMatch.index >= pendingMatch.index) reasons.push("the early-return gate appears after pending*.set(");
    }

    return { varName: v, index: site.index, ok: reasons.length === 0, reasons };
  });

  return { sites: results, unassignedCount: rawCallIndices.length - sites.length };
}

// ============================= (1) POSITIVE CONTROL — synthetic fixtures =============================
// Proves the detector catches exactly the shapes named above, on names it has never seen (never real
// `delivered`/`deliverError`/`pendingXxx` names from the real file).
{
  const GOOD = `
async function leverGood(ctx, ok, deliverToOwnerError, pendingFixtureA) {
  const handed = await ctx.outbound.deliverToOwner(ctx.sessionId, "text");
  const handedError = deliverToOwnerError(handed);
  if (handedError) return handedError;
  pendingFixtureA.set("k", { x: 1 });
  return ok({ status: "proposed" });
}
`;
  const good = scanDeliverToOwnerSites(GOOD);
  check("(1a) a clean fixture lever (never-seen names) has exactly 1 site, all OK", good.sites.length === 1 && good.sites.every((s) => s.ok));

  const TRAP_INLINE_IF = `
async function leverTrap(ctx, ok, pendingFixtureB) {
  const handed = await ctx.outbound.deliverToOwner(ctx.sessionId, "text");
  if (!handed) return ok({ error: "couldn't deliver" });
  pendingFixtureB.set("k", { x: 1 });
  return ok({ status: "proposed" });
}
`;
  const trap = scanDeliverToOwnerSites(TRAP_INLINE_IF);
  check("(1b) the exact latent-trap shape — inline `if (!handed)`, never calls deliverToOwnerError — is caught",
    trap.sites.length === 1 && !trap.sites[0].ok && trap.sites[0].reasons.some((r) => r.includes("latent trap")));

  const TRAP_POSITIVE_IF = `
async function leverTrapPositive(ctx, ok, pendingFixtureB2) {
  const handed = await ctx.outbound.deliverToOwner(ctx.sessionId, "text");
  if (handed) {
    pendingFixtureB2.set("k", { x: 1 });
    return ok({ status: "proposed" });
  }
  return ok({ error: "nope" });
}
`;
  const trapPositive = scanDeliverToOwnerSites(TRAP_POSITIVE_IF);
  check("(1b) the fail-OPEN shape — inline `if (handed)` treating \"timeout\" as a confirmed propose — is caught",
    trapPositive.sites.length === 1 && !trapPositive.sites[0].ok);

  const MISORDERED = `
async function leverMisordered(ctx, ok, deliverToOwnerError, pendingFixtureC) {
  const handed = await ctx.outbound.deliverToOwner(ctx.sessionId, "text");
  pendingFixtureC.set("k", { x: 1 });
  const handedError = deliverToOwnerError(handed);
  if (handedError) return handedError;
  return ok({ status: "proposed" });
}
`;
  const misordered = scanDeliverToOwnerSites(MISORDERED);
  check("(1c) a gate present but AFTER pending*.set( is caught (ordering, not just presence)",
    misordered.sites.length === 1 && !misordered.sites[0].ok);

  const WRONG_VAR = `
async function leverWrongVar(ctx, ok, deliverToOwnerError, pendingFixtureD) {
  const handed = await ctx.outbound.deliverToOwner(ctx.sessionId, "text");
  const other = true;
  const handedError = deliverToOwnerError(other);
  if (handedError) return handedError;
  pendingFixtureD.set("k", { x: 1 });
  return ok({ status: "proposed" });
}
`;
  const wrongVar = scanDeliverToOwnerSites(WRONG_VAR);
  check("(1d) a gate called with the WRONG variable (not the captured delivery result) is caught",
    wrongVar.sites.length === 1 && !wrongVar.sites[0].ok && wrongVar.sites[0].reasons.some((r) => r.includes("not the captured delivery result")));

  const UNASSIGNED_USE = `
async function leverUnassigned(ctx, ok, pendingFixtureE) {
  if (await ctx.outbound.deliverToOwner(ctx.sessionId, "text")) {
    pendingFixtureE.set("k", { x: 1 });
    return ok({ status: "proposed" });
  }
  return ok({ error: "nope" });
}
`;
  const unassigned = scanDeliverToOwnerSites(UNASSIGNED_USE);
  check("(1e) a deliverToOwner( result used directly (never captured into a local) is flagged as unassigned",
    unassigned.unassignedCount === 1 && unassigned.sites.length === 0);

  // NEGATIVE CONTROL: the chokepoint's OWN definition — which legitimately contains `if (!delivered)` and
  // `if (delivered === "timeout")` on its OWN parameter named `delivered` — must not poison a LATER, clean
  // lever just because that literal text exists earlier in the same file. The real file's layout (the
  // chokepoint defined once, well before any call site) makes this naturally true of the per-site windowing
  // above; this fixture proves it rather than assuming it.
  const WITH_CHOKEPOINT_DEF = `
function deliverToOwnerError(delivered) {
  if (delivered === "timeout") return { error: "timeout-msg" };
  if (!delivered) return { error: "fail-msg" };
  return null;
}

async function leverGood2(ctx, ok, pendingFixtureF) {
  const delivered = await ctx.outbound.deliverToOwner(ctx.sessionId, "text");
  const deliverError = deliverToOwnerError(delivered);
  if (deliverError) return deliverError;
  pendingFixtureF.set("k", { x: 1 });
  return ok({ status: "proposed" });
}
`;
  const withDef = scanDeliverToOwnerSites(WITH_CHOKEPOINT_DEF);
  check("(1f-control) the chokepoint's own `if (!delivered)`/`if (delivered===\"timeout\")` body does NOT poison a later clean lever reusing the same param name",
    withDef.sites.length === 1 && withDef.sites[0].ok);
}

// ============================= (2) THE REAL SCAN — capabilities.ts today =============================
let realStripped;
{
  const raw = fs.readFileSync(SRC_FILE, "utf8");
  realStripped = stripComments(raw);
  const { sites, unassignedCount } = scanDeliverToOwnerSites(realStripped);

  // Positive control (delta Code Review bdb48960, finding 1): must find the full known population — a
  // broken/over-narrowed regex returning 0 would make every assertion below vacuously pass.
  check(`(2) finds the known population of deliverToOwner( call sites in capabilities.ts (today: 8, found ${sites.length})`,
    sites.length === 8);
  check("(2) every deliverToOwner( call site's result is captured into a local (none used directly/unassigned)",
    unassignedCount === 0);

  const offenders = sites.filter((s) => !s.ok);
  check(`(2) EVERY deliverToOwner( call site in capabilities.ts is gated through deliverToOwnerError before any pending*.set, with no direct truthiness shortcut (offenders: ${offenders.length === 0 ? "none" : offenders.map((s) => `var '${s.varName}' @offset ${s.index}: ${s.reasons.join("; ")}`).join(" | ")})`,
    offenders.length === 0);
}

// ============================= (3) PROVE RED — mutate the REAL file in-memory =============================
// Card b343c5f0 round 2, delta Code Review `bdb48960`: "Prove RED by temporarily reverting one site to an
// inline if (!delivered)." Done here as an in-memory string mutation of the REAL stripped source (never
// written to disk) — this proves the detector would catch exactly this regression on the real code's own
// shape, not merely on a synthetic fixture, while leaving the other 7 real sites to prove no collateral
// false positive.
{
  const { sites: beforeSites } = scanDeliverToOwnerSites(realStripped);
  const target = beforeSites[0]; // the decision_resolve site — first in file order
  check("(3) sanity: the mutation target is a real, currently-OK site", !!target && target.ok);

  const lineEnd = realStripped.indexOf("\n", target.index);
  const afterAssign = realStripped.slice(lineEnd + 1);
  const pendingMatch = /pending\w*\.set\(/.exec(afterAssign);
  check("(3) sanity: found a pending*.set( to anchor the mutation against", !!pendingMatch);
  const gateBlock = afterAssign.slice(0, pendingMatch.index);
  check("(3) sanity: the block being removed really contains the real deliverToOwnerError( gate (so the mutation is a genuine revert, not a no-op)",
    /deliverToOwnerError\(/.test(gateBlock));

  const trapReplacement = `\n        if (!${target.varName}) return ok({ error: "simulated trap: inline check, never calls deliverToOwnerError" });\n`;
  const mutated = realStripped.slice(0, lineEnd + 1) + trapReplacement + afterAssign.slice(pendingMatch.index);

  const { sites: afterSites } = scanDeliverToOwnerSites(mutated);
  check("(3) RED PROOF: after reverting the first site to an inline if(!delivered), the scan count is unchanged (8 sites)",
    afterSites.length === 8);
  check("(3) RED PROOF: the mutated (first) site is now flagged", !afterSites[0].ok);
  check("(3) RED PROOF: the mutated site is flagged for the latent-trap reason specifically",
    afterSites[0].reasons.some((r) => r.includes("latent trap")));
  check("(3) RED PROOF: the OTHER 7 real sites are UNAFFECTED by the mutation (no collateral false positive)",
    afterSites.slice(1).every((s) => s.ok));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the deliverToOwner/deliverToOwnerError gating detector catches the latent-trap truthiness check (both fail-open and fail-closed polarities), a misordered gate, a wrong-variable gate, and an unassigned/direct use on never-seen names; correctly clears a clean lever even when the chokepoint's own `if (!delivered)` body sits earlier in the same file; finds the full known population (8) in the real capabilities.ts with zero offenders; and, mutated in-memory to revert one real site to the exact trap shape named in review, flags that one site and only that one."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
