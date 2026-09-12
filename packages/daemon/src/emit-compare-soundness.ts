import fs from "node:fs";
import path from "node:path";

/** Narrow structural type for the `typescript` package's surface this module actually uses — kept as an
 *  independently-declared type (not an import of `typescript`'s own, much larger public types) so a
 *  loader (async `import()`, or a synchronous `require`) only needs to produce a value shaped like this.
 *  Shared by both `git/worktrees.ts` (async `import("typescript")`) and `deploy-staleness.ts` (synchronous
 *  `createRequire` load) — the loaders differ; the shape they must produce does not. */
export interface TypeScriptModuleLike {
  transpileModule(input: string, opts: unknown): { outputText: string };
  // @decision 18bfe989 — never widen back to `Record<string, unknown>`: an undefined `ScriptTarget` lookup
  // used to reach `transpileModule` silently (fixed up to ES5, not an error), which could make a real
  // behavioural change read transpile-identical instead of failing this compile.
  ScriptTarget: Record<string, number>;
  ModuleKind: Record<string, unknown>;
}

/** Single-file, syntax-only transpile with `removeComments:true` forced — see `computeEmitCompareGate`'s
 *  own doc (git/worktrees.ts) for why this (not a hand-rolled scanner, not the real `dist/` build) is the
 *  right tool: a textual "comments-only" check desyncs on template literals. `target` is a REQUIRED,
 *  explicit parameter — never defaulted, since a default is exactly what let this helper's two former
 *  copies silently diverge (`git/worktrees.ts` needs `ES2022` for a changed `.ts` file to match
 *  `tsconfig.base.json`'s real target, matching what `dist/` actually ships, and `ESNext` for a changed
 *  `.mjs` script — a script is never compiled by this repo's tsconfig chain at all, so `ES2022` would be
 *  UNSOUND there: it can downlevel syntax the original file never runs through; `deploy-staleness.ts` uses
 *  `ES2022` for its own `.ts`-only diff). `target: number`, never `unknown` (card 18bfe989) — `unknown`
 *  only enforced an argument was PRESENT, not that it was a valid target, so an explicit `undefined` (a
 *  `ScriptTarget` lookup that missed) passed through silently. `module` stays fixed at `NodeNext` for
 *  every caller — every other compiler option is irrelevant here since `transpileModule` never
 *  type-checks. */
export function transpileIgnoringCommentsAndWhitespace(
  text: string,
  fileName: string,
  tsModule: TypeScriptModuleLike,
  target: number,
): { outputText: string } {
  return tsModule.transpileModule(text, {
    compilerOptions: {
      target,
      module: tsModule.ModuleKind.NodeNext,
      removeComments: true,
      sourceMap: false,
      declaration: false,
    },
    fileName,
  });
}

/** No try/catch here, deliberately: a `readdirSync` failure (a build racing this read, `EPERM`/`EBUSY`/
 *  `ENOENT`) MUST propagate to the caller's own try/catch (`emitCompareSoundnessOk`, below), which fails
 *  the WHOLE soundness check closed to `false`. Swallowing it here and returning whatever was accumulated
 *  so far would let the soundness check read `true` off a PARTIAL scan — a real `const enum` sitting in
 *  the unscanned remainder would then silently pass, exactly the fail-open this check exists to prevent.
 *  @decision 8abf427f — never re-export this: no external consumer (MEASURED), and its no-try/catch
 *  contract is hazard-specific to `emitCompareSoundnessOk`'s own catch, not a general-purpose walker. */
function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// @decision bafc68e7 — never default `scope`; a default is exactly what let this predicate's two prior,
// independent copies (git/worktrees.ts, deploy-staleness.ts) silently diverge before being consolidated
// here. Each caller must state its own tsconfig/src-dir coverage explicitly.
export interface EmitCompareSoundnessScope {
  /** tsconfig paths, relative to `repoRoot`, each checked for `emitDecoratorMetadata: true`. Must name
   *  every config in the caller's real `extends` chain — checking only the base config would miss a
   *  package-specific compiler option. */
  tsconfigRelPaths: string[];
  /** src dirs, relative to `repoRoot`, each walked for a `const enum` declaration. */
  srcDirRelPaths: string[];
}

/** @decision 2154b6ad — never check only tsconfig.base.json for this precondition; a package-specific
 *  compiler option (e.g. on packages/daemon/tsconfig.json) would be invisible to it. Fails closed to
 *  `false` on any read/parse error. */
// @decision bafc68e7 — never let an EMPTY scope array read as "sound": `string[]` admits `[]`, and a scope
// naming nothing to check would otherwise scan nothing and report success — the exact fail-open shape this
// module exists to close.
export function emitCompareSoundnessOk(repoRoot: string, scope: EmitCompareSoundnessScope): boolean {
  if (scope.tsconfigRelPaths.length === 0 || scope.srcDirRelPaths.length === 0) return false;
  for (const tsconfigRelPath of scope.tsconfigRelPaths) {
    try {
      const raw = fs.readFileSync(path.join(repoRoot, tsconfigRelPath), "utf8");
      const opts = (JSON.parse(raw) as { compilerOptions?: Record<string, unknown> }).compilerOptions;
      if (opts?.emitDecoratorMetadata === true) return false;
    } catch {
      return false;
    }
  }
  // Requires the actual DECLARATION shape (`const enum <Identifier> {`), not just the two words adjacent —
  // deliberately tighter than a bare `\bconst\s+enum\b`. Two real false positives on the LOOSER pattern
  // were found by running this exact check against this exact repo before shipping it: (1) a variable
  // merely NAMED `const enumerate = ...` (pty/host.ts's own process-enumeration helper — kept as this
  // check's positive control in `test/emit-compare-soundness-guard.mjs`, the pattern must NOT match that
  // line), and (2) doc comments elsewhere in this codebase that explain the `const enum` mechanism in
  // prose ("`const enum` (its members are INLINED..." etc.) — a bare word-adjacency regex tripped on its
  // own documentation. Requiring `<Identifier> {` immediately after excludes both: prose describing the
  // concept doesn't happen to place an identifier and an open brace right after the words "const enum"
  // (and if a future comment ever DID include a worked-example declaration in that exact shape, the worst
  // case is the same safe direction — an unnecessary fail-closed, never a missed real one).
  const CONST_ENUM = /\bconst\s+enum\s+[A-Za-z_$][\w$]*\s*\{/;
  try {
    for (const srcDirRelPath of scope.srcDirRelPaths) {
      for (const file of walkTsFiles(path.join(repoRoot, srcDirRelPath))) {
        if (CONST_ENUM.test(fs.readFileSync(file, "utf8"))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
