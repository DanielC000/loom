import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs/typescript below, no daemon/Db used
// TRANSPILE-TARGET NARROWING GUARD (card 18bfe989, Code Reviewer finding F4 on card bafc68e7).
//
// `emit-compare-soundness.ts`'s `TypeScriptModuleLike.ScriptTarget` used to be `Record<string, unknown>`
// and `transpileIgnoringCommentsAndWhitespace`'s `target` param was `unknown` — both call sites
// (`deploy-staleness.ts`, `git/worktrees.ts`) read `tsModule.ScriptTarget.ES2022`/`.ESNext` and passed it
// straight through with no runtime check. If the resolved `typescript` module were ever missing that key
// (an unresolvable module already has its own `notApplicableHere`/`null` branch, but a MISMATCHED module —
// a stub, a shim, a different major — would not), `target` arrives `undefined`. `ts.transpileModule` does
// NOT throw or warn on an `undefined` target with the diagnostics options this code uses (reportDiagnostics
// is never set) — it silently fixes up to `ES5`. Two class-field variants that are genuinely BEHAVIOURALLY
// DIFFERENT under this repo's real ES2022 emit (`useDefineForClassFields`) transpile BYTE-IDENTICAL at ES5
// — so a real code change would read transpile-identical, and `computeEmitCompareGate` would REDUCE a gate
// that should have run in full. A fail-open that returns the success value, invisible to every test.
//
// The fix (card 18bfe989) narrows the TYPES instead of adding a runtime check: `ScriptTarget: Record<string,
// number>` and `target: number`. This repo's `noUncheckedIndexedAccess` then types
// `mod.ScriptTarget.ES2022` as `number | undefined`, so BOTH call sites become a compile error until they
// narrow away `undefined` explicitly (and now fail closed to `notApplicableHere`/`null` when they do).
//
// "A test asserting the types compile is not one — a compile error is the mechanism" (the card's own
// standing test). So this file checks TWO independent things, neither of which is "does `pnpm build`
// pass today":
//   (1) SOURCE-TEXT check that the type declaration is still narrowed to `number` — the actual compile-time
//       backstop. Reverting `ScriptTarget`/`target` back to `unknown` would not itself break `pnpm build`
//       (both call sites already narrow with an explicit `=== undefined` check, which still compiles fine
//       against a widened `unknown`/`unknown | undefined` type) — so this is the ONE check that would
//       actually go red on that specific regression, and it must read real SOURCE (not `dist/`, which has
//       no types once compiled).
//   (2) BEHAVIOURAL reproduction, against the REAL, BUILT `transpileIgnoringCommentsAndWhitespace` and the
//       REAL `typescript` devDependency: the reviewer's own fixture pair (`class C { x = 1 }` vs the
//       explicit-constructor equivalent) transpiles byte-IDENTICAL when `target` is `undefined` (MEASURED
//       reproduction of the exact fail-open this card closes — reachable here because this test is plain
//       JS, so TypeScript's compile-time guard does not apply to what THIS file can pass at runtime) and
//       byte-DIFFERENT at the real production target (`ES2022`) — proving the fixture is a genuine
//       discriminator, not a coincidence of this one repo's typescript version.
//
// Run: pnpm --filter @loom/daemon build && node packages/daemon/test/emit-compare-transpile-target-narrowing.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const soundnessSrc = path.join(repoRoot, "packages", "daemon", "src", "emit-compare-soundness.ts");
const soundnessDist = path.join(__dirname, "..", "dist", "emit-compare-soundness.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── (1) SOURCE-TEXT: the type declaration is narrowed, and stays narrowed ──────────────────────────────
const src = fs.readFileSync(soundnessSrc, "utf8");
check(
  "(A) TypeScriptModuleLike.ScriptTarget is declared Record<string, number>",
  /ScriptTarget:\s*Record<string,\s*number>/.test(src),
);
check(
  "(B) transpileIgnoringCommentsAndWhitespace's target param is declared `target: number,`",
  /\btarget:\s*number,/.test(src) && !/\btarget:\s*unknown,/.test(src),
);
// Negative control: a pattern that must NOT match this file, proving (A)/(B)'s regexes actually
// discriminate rather than matching everything (or nothing) vacuously.
check(
  "(control) a bogus type shape ('ScriptTarget: Record<string, boolean>') does NOT match this source",
  !/ScriptTarget:\s*Record<string,\s*boolean>/.test(src),
);
// Positive control on the SAME pattern family, against a known-present sibling declaration in this same
// file — proves (A)'s regex shape (`Record<string, X>`) is capable of matching at all, not just failing
// to find its target by coincidence of a broken pattern.
check(
  "(sanity) the sibling ModuleKind: Record<string, unknown> declaration IS found by the same pattern family",
  /ModuleKind:\s*Record<string,\s*unknown>/.test(src),
);

// ── (2) BEHAVIOURAL: the reviewer's fixture pair, against the real built function + real typescript ────
const { transpileIgnoringCommentsAndWhitespace } = await import(pathToFileURL(soundnessDist).href);
const req = createRequire(import.meta.url);
const tsModule = req("typescript");

const FIXTURE_A = "export class C { x = 1; }\n";
const FIXTURE_B = "export class C { x: number; constructor() { this.x = 1; } }\n";

const es5A = transpileIgnoringCommentsAndWhitespace(FIXTURE_A, "fixture.ts", tsModule, undefined).outputText;
const es5B = transpileIgnoringCommentsAndWhitespace(FIXTURE_B, "fixture.ts", tsModule, undefined).outputText;
check(
  "(C) MEASURED danger reproduction: target:undefined collapses the two genuinely-different fixtures to byte-identical output (the exact fail-open this card closes)",
  es5A === es5B,
);

const realTarget = tsModule.ScriptTarget.ES2022;
check("(sanity) the real typescript module resolves ScriptTarget.ES2022", typeof realTarget === "number");
const es2022A = transpileIgnoringCommentsAndWhitespace(FIXTURE_A, "fixture.ts", tsModule, realTarget).outputText;
const es2022B = transpileIgnoringCommentsAndWhitespace(FIXTURE_B, "fixture.ts", tsModule, realTarget).outputText;
check(
  "(D) at the real production target (ES2022), the same two fixtures are genuinely DIFFERENT — the discriminator this whole check exists to preserve",
  es2022A !== es2022B,
);

console.log(failures === 0
  ? "\n✅ ALL PASS — ScriptTarget/target stay narrowed to `number` at the source (compile-time backstop), and the reviewer's class-field fixture pair reproduces the exact ES5 collapse an `undefined` target would cause while genuinely discriminating at the real ES2022 target."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
