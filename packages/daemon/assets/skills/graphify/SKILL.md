---
name: graphify
description: Use to orient in an unfamiliar codebase with graphify, a local tree-sitter code graph — "what does this symbol touch", "how do these two connect", "trace this call chain". Opt-in (the human installs graphify once). A forward-orientation aid, NOT a reliable reverse-dependency tool. Shipped and kept current by Loom.
---

# graphify

`graphify` builds a **local, code-only call graph** with tree-sitter — no API key, no LLM backend, no
token cost. Use it as a **forward-orientation aid**: given a symbol, see what it calls and how two
symbols connect. It is fast and accurate for that.

**The one thing to internalize:** graphify is strong going *forward* (`explain` / `path`) and
**unreliable going backward** (`affected` — "what breaks if I change X"). Treat forward queries as
trustworthy orientation and reverse queries as a lead to confirm with grep — never as ground truth.

## Setup (opt-in — assume it's present)

One-time, human-installed like any host tool: `uv tool install graphifyy` (or `pipx install graphifyy`,
or `pip install graphifyy`). This skill assumes it's already there. If `graphify` isn't on PATH, say so
and fall back to grep/Read — don't try to install it yourself.

## Build the graph (code-only)

```
graphify update <dir>
```

Point `<dir>` at your source root (e.g. `src`). This writes `<dir>/graphify-out/graph.json`. **Only ever
use `update`.** Never run `extract` or point it at a semantic/LLM backend, and never pass an API key —
code-only keeps it free and local. Rebuild after substantial code changes; the graph is a snapshot.

## Use it — forward orientation (the strength)

Pass `--graph <dir>/graphify-out/graph.json` to each query.

- **`graphify explain "<Symbol>"`** — what this symbol touches: its outgoing calls and immediate
  neighbors. The go-to "what does this do / what does it reach" query.
- **`graphify path "<A>" "<B>"`** — how two symbols connect, if they do. Good for "does this handler
  actually reach that writer".

## The `affected` warning (load-bearing)

`graphify affected "<Symbol>"` claims to list callers ("what depends on this"). **It under-reports, and
silently** — a confident-looking short answer that misses real callers. It does not build caller edges
for method calls on a locally-constructed instance (`const x = new Foo(); x.method()`) or on a
closure/parameter receiver (a callback closing over an injected service). So a method that *is* called
can come back "No affected nodes found".

Therefore: **never trust `affected` for "what breaks if I change X" — grep for the symbol to confirm
reverse-dependency completeness.** (Verified on graphify 0.9.5; tracked upstream as safishamsi/graphify#1630.)

## Other caveats

- **Skip the natural-language `query`** command — it's a noisy keyword search, not useful for orientation.
- **`[INFERRED]` edges are verify-before-trust** — confirm them against the code; `[EXTRACTED]` edges are
  the reliable ones.
- **Not everything is a node** — config-object fields and bare module-level `const`s don't appear in the
  graph. Grep for those instead of expecting `explain`/`affected` to find them.

## Keep it reversible and trust-safe

- **Never commit the graph.** Add `graphify-out/` to `.git/info/exclude` so the artifacts stay untracked
  and local.
- **Never run `graphify hook install`** or any export/integration subcommand — they edit files like
  `CLAUDE.md` or add git hooks. Build the graph on demand, query it, and leave the repo otherwise
  untouched.
