// Card 1ebbf523 — see docs/decisions/1ebbf523-npm-pinned-lock-pack-assertion.md for the full defect
// this closes: the EARLIER npm-pinned-lock check (firstNpmPinnedLockAsset, card 66ab2bc0) only verified
// a single representative lock exists in the SOURCE assets dir, before the copy — it could not see
// npm's own `npm pack` file-inclusion logic potentially dropping a nested package-lock.json at PACK
// time, and it passed even when one seeded row's lock was lost from the pack while another survived.
//
// requiredNpmPinnedLockPackedPaths() derives the full expected set of packed lock paths from the real
// built seed data (dist/capabilities/seed.js) + the daemon's own lock-path function
// (dist/capabilities/npm-pinned.js) — never a hardcoded file list. missingPackedPaths() is the pure
// diff against npm's own packed file list. This test exercises BOTH pure functions against the REAL
// built dist (same precondition npm-pinned-seed-lock-parity.mjs already relies on) but never runs a
// real `npm pack` or touches dist-npm/ — fast and hermetic.
//
// Run: 1) pnpm build (or at least `pnpm --filter @loom/daemon build`), 2) node test/build-npm-package-pinned-lock-pack-guard.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredNpmPinnedLockPackedPaths, missingPackedPaths } from "../../../scripts/build-npm-package.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const daemonDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");

const required = await requiredNpmPinnedLockPackedPaths(daemonDist);
check("derives at least two required npm-pinned lock packed paths (shadcn, image-gen)", required.length >= 2);
check(
  "every derived path is shaped assets/npm-pinned-locks/<pkg>/<version>/package-lock.json",
  required.every((p) => /^assets\/npm-pinned-locks\/[^/]+\/[^/]+\/package-lock\.json$/.test(p)),
);
// Package presence is asserted by PACKAGE NAME only, never a pinned version literal — the version
// constants in capabilities/seed.ts move independently of this test (card e8aa3e98: a version bump with
// no matching test update desynced this exact assertion from the real pin). required() is itself the
// derived source of truth; this only confirms it actually produced a row for each bundled package.
check(
  "includes the shadcn row's lock path (any pinned version)",
  required.some((p) => p.startsWith("assets/npm-pinned-locks/shadcn/")),
);
check(
  "includes the image-gen (mcp-imagenate) row's lock path (any pinned version)",
  required.some((p) => p.startsWith("assets/npm-pinned-locks/mcp-imagenate/")),
);

// Negative control: a packed file list containing every required path (plus unrelated ordinary files)
// reports nothing missing.
check(
  "[negative control] a packed list containing every required path reports zero missing",
  missingPackedPaths(required, [...required, "bin/loom.mjs", "package.json", "README.md"]).length === 0,
);

// Positive control: the EXACT case the old source-only check could not see — ONE row's lock is lost
// from the packed set while the other(s) survive.
const oneDropped = required.slice(1);
const missingOneDropped = missingPackedPaths(required, oneDropped);
check(
  "[positive control] dropping ONE required lock from the packed set, while others survive, is detected",
  missingOneDropped.length === 1 && missingOneDropped[0] === required[0],
);

// Positive control: an entirely empty packed file list (e.g. a malformed npm pack result) flags every
// required path as missing, not just one.
check(
  "[positive control] an empty packed file list flags every required path as missing",
  missingPackedPaths(required, []).length === required.length,
);

// missingPackedPaths is a pure set diff — order of the packed list must never matter.
check(
  "[order independence] a packed list in reverse order still reports zero missing",
  missingPackedPaths(required, [...required].reverse()).length === 0,
);

console.log(`\n${failures === 0 ? "✅" : "❌"} build-npm-package-pinned-lock-pack-guard: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
