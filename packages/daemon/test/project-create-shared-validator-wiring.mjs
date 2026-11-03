// Card 793010d9 — proves `POST /api/projects` and `POST /api/setup/project-init` (gateway/server.ts)
// both actually ROUTE THROUGH the one shared `validateProjectCreateInput` (projects/create-input.ts),
// rather than merely behaving alike while each still hand-wires its own copy of the
// referenceRepos/noGateByDesign/denyGlobs/repos/config/triple-containment/pin-conflict chain. That two-
// path duplication is exactly how `config` validation was missed on both routes until card afda2a26 —
// project-create-config-validation.mjs (etc.) proves the BEHAVIOR stays correct, but two independently-
// correct implementations would pass that file identically; this file is the structural guard that there
// is now only ONE implementation to go wrong.
//
// METHOD (mirrors anchor-re-parity.mjs's own comment-immune technique): read gateway/server.ts SOURCE
// TEXT directly (never dist/, never imported), find each route's own `  app.post("...", ...)`
// registration line ANCHORED to the start of a line (`^  app\.post\(` — a `//`-prefixed comment line in
// this codebase's convention never starts this way, so a comment mentioning the same route path cannot
// false-positive this), then bound that route's own handler body from there to the NEXT top-level
// `  app.<verb>(` registration. Within that bounded region, assert (also line-anchored, so a doc comment
// that merely NAMES a function in prose can never satisfy or defeat either assertion):
//   (a) a `const createCheck = await validateProjectCreateInput(` call is present exactly once;
//   (b) NONE of the six old per-field calls this call replaced are still present as their own
//       assignment — proving the duplication was actually REMOVED, not merely wrapped alongside it.
// A POSITIVE CONTROL runs the identical extraction against the PATCH /api/projects/:id route, which
// still calls `validateReferenceRepos`/`validateDenyGlobs`/`validateRepoRegistry`/
// `checkVaultRepoTripleContainment` directly (it has its own, deliberately NOT-shared update-time
// chain) — proving the anchored pattern can find a real call when one exists, so the create routes'
// zero result is a genuine absence, not a broken pattern. A NEGATIVE CONTROL searches each create
// route's own region for a bogus function name and confirms it finds nothing, proving the pattern can
// fail at all.
//
// Run: `node test/project-create-shared-validator-wiring.mjs` from packages/daemon (no build, no
// LOOM_HOME needed — reads SOURCE files directly).
//
// NOT in CHANGED_TS_TEXT_SCANNER_REPO_PATHS (git/worktrees.ts): that list's own membership criterion is
// a RAW scan where "a comment anywhere in the scanned region can change what the scan matches" — every
// assertion here is instead line-anchored to a token (`^  app\.post\(`, `^\s*(?:const|let)\s+\w+\s*=`,
// `^export async function`) that this codebase's `//`/`/** ` comment convention never produces at the
// start of a line, the same comment-immune shape anchor-re-parity.mjs already uses and that list's own
// doc names as a "NOT a member" exemption. A comment naming `validateProjectCreateInput(` in prose
// (e.g. this very header) cannot satisfy or defeat either check.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "src", "gateway", "server.ts");
const createInputPath = path.join(__dirname, "..", "src", "projects", "create-input.ts");
const serverSrc = fs.readFileSync(serverPath, "utf8");
const createInputSrc = fs.readFileSync(createInputPath, "utf8");

/** Line-anchored route-registration regex: `//`-prefixed comments in this codebase never start a line
 *  this way, so this can only ever match a real registration, never a comment naming one. */
function routeAnchorRe(method, pathLiteral) {
  return new RegExp(`^  app\\.${method}\\("${pathLiteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",`, "m");
}

/** Slice `src` from `startRe`'s match to the NEXT top-level `  app.<verb>(` registration (or EOF) —
 *  the same bounded-region technique the file header describes. Returns null if `startRe` has no match. */
function sliceRouteBody(src, startRe) {
  const startMatch = startRe.exec(src);
  if (!startMatch) return null;
  const bodyStart = startMatch.index + startMatch[0].length;
  const nextRouteRe = /^  app\.(get|post|patch|put|delete)\(/m;
  nextRouteRe.lastIndex = 0;
  const rest = src.slice(bodyStart);
  const nextMatch = nextRouteRe.exec(rest);
  return nextMatch ? rest.slice(0, nextMatch.index) : rest;
}

/** A line-anchored "this identifier was assigned via a call to `name(`" check — immune to a prose
 *  comment naming the same function, since no comment in this codebase's `//`/`/** ` convention ever
 *  starts a line with `const`/`let`. */
function hasAnchoredCall(region, name) {
  const re = new RegExp(`^\\s*(?:const|let)\\s+\\w+\\s*=\\s*(?:await\\s+)?${name}\\(`, "m");
  return re.test(region);
}

// ===================== positive control: the pattern CAN find a real call =====================
{
  const patchBody = sliceRouteBody(serverSrc, routeAnchorRe("patch", "/api/projects/:id"));
  check("[control] PATCH /api/projects/:id route body found", patchBody !== null);
  check("[control] ★ anchored-call pattern finds the REAL validateReferenceRepos( call on the PATCH route",
    patchBody !== null && hasAnchoredCall(patchBody, "validateReferenceRepos"));
  check("[control] ★ anchored-call pattern finds the REAL validateDenyGlobs( call on the PATCH route",
    patchBody !== null && hasAnchoredCall(patchBody, "validateDenyGlobs"));
}

// ===================== negative control: the pattern CAN return zero =====================
{
  const initBody = sliceRouteBody(serverSrc, routeAnchorRe("post", "/api/setup/project-init"));
  check("[control] ★ a bogus function name is NOT found in the project-init route body (pattern can fail)",
    initBody !== null && !hasAnchoredCall(initBody, "validateProjectCreateInputZZZ"));
}

// ===================== the real proof: both create routes share ONE validator =====================
const OLD_CALLS = ["validateReferenceRepos", "validateDenyGlobs", "validateRepoRegistry", "checkVaultRepoTripleContainment", "validateProjectConfigOverride"];

for (const [label, method, routePath] of [
  ["project-init", "post", "/api/setup/project-init"],
  ["POST /api/projects", "post", "/api/projects"],
]) {
  const body = sliceRouteBody(serverSrc, routeAnchorRe(method, routePath));
  check(`(${label}) route body found`, body !== null);
  if (body === null) continue;
  check(`(${label}) ★ calls the shared validateProjectCreateInput( exactly once`,
    (body.match(/^\s*const createCheck = await validateProjectCreateInput\(/gm) ?? []).length === 1);
  for (const oldCall of OLD_CALLS) {
    check(`(${label}) ★ no longer hand-wires its own ${oldCall}( call (duplication actually removed, not just wrapped)`,
      !hasAnchoredCall(body, oldCall));
  }
}

// ===================== the shared function actually exists and is exported =====================
check("validateProjectCreateInput is declared + exported in projects/create-input.ts",
  /^export async function validateProjectCreateInput\(/m.test(createInputSrc));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
