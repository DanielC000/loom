// A minimal ESM loader hook (node:module `register()`) that lets a hermetic node test script — no
// bundler, no jsdom — import a REAL .ts/.tsx source file directly. It does two things a plain
// `node --experimental-strip-types` run can't: (1) resolves an extensionless relative specifier (the
// bundler-style imports our source uses, e.g. `../../theme`) to its `.ts`/`.tsx` sibling, and (2)
// transpiles TS + JSX to plain ESM via the `typescript` compiler API (already a repo devDependency —
// no new dependency needed) before Node evaluates it. Used by uiPropForwarding.mjs to render the
// actual shipped `components/ui` primitives and assert on their real output, not a reimplementation.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TS_EXTS = [".tsx", ".ts"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    for (const ext of TS_EXTS) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        // try the next candidate extension
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: url,
    });
    return { format: "module", source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
