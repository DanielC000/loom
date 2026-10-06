# 0a03059e — the real prod DB refuses by default; the daemon boot declares itself, other callers opt in explicitly

Card `0a03059e`. A live, non-archived project row (`id:"p1"`, `name:"N"`, `repoPath`/`vaultPath:"/tmp"`)
turned up in the real Loom DB, created 2026-10-03. Extensive investigation (every REST/MCP project-create
path mints `randomUUID()`; no committed test fixture produces a literal `"/tmp"` on Windows, since
`os.tmpdir()` never returns a POSIX path there even with TEMP/TMP/TMPDIR unset; no production script calls
`insertProject`) ruled out every committed source. The row was written by a raw, **uncommitted** ad-hoc
script that imported `dist/db.js` directly and called `db.insertProject()` with no `LOOM_HOME` override.

The pre-existing guard (`assertNotProdDbInTest`, now `assertProdDbOpenAllowed`) only refused the real prod
DB under a test marker (`LOOM_TEST`/`NODE_ENV=test`) or an entry script resolving inside
`packages/daemon/test/`. A script that is neither — outside `test/`, no test marker, never committed —
sailed through with no throw. Reproduced safely (a fake `HOME`/`USERPROFILE` override, never the real
`~/.loom`): the identical `new Db()` + `insertProject()` call succeeded silently outside `test/` with no
markers set, and correctly threw once `LOOM_TEST=1` was set (positive control). No committed source-scan
guard (`STATIC_GUARD_REPO_PATHS`, `createworktree-loom-home-guard.mjs`) could ever close this gap, since
its defining property is that the culprit script was never committed in the first place.

## The fix

The guard flips from "allow unless marked test" to "refuse the real prod DB unless the caller is
positively known-safe," decided in this order:

1. A test marker (`LOOM_TEST`/`NODE_ENV=test`) or an entry script resolving inside `packages/daemon/test/`
   — **always refuses**, no override. A test should never have a legitimate reason to touch the real prod
   DB, so this takes precedence over both reasons below.
2. The real daemon boot (`index.ts`) declared itself via `declareDaemonProcess()`, called once before its
   own `new Db()` — allowed.
3. An explicit, deliberate CODE opt-in — `{ allowProdDb: true }` on the `Db` constructor — allowed. For a
   human-run, one-off utility that has already decided (through its own gating) that touching the live DB
   is intentional — e.g. `backfill-task-relations.mjs`'s `--allow-live` + mandatory backup + daemon-down
   check, which now also sets the opt-in right before its own `new Db(file)` call so its existing
   `--allow-live` semantics are unchanged.

**No env-var opt-in exists, deliberately (card 45fba6cf's Code Review finding).** An earlier draft of this
fix added `LOOM_ALLOW_PROD_DB=1` alongside the code option — but `<LOOM_HOME>/.env` is loaded into the
daemon's own env (`bin/loom.mjs`, `daemon-supervisor.mjs`), and `pty/host.ts`'s `buildSpawnEnv` copies
`process.env` into every spawned agent session. An env var would mean one operator setting it once
re-exposes the real DB to every ad-hoc script in every agent session — reopening the exact hole this card
closes, just one level removed. The code option has no such ambient-propagation path.

Anything else — an uncommitted ad-hoc script, a forgotten `--db` arg, a one-off `node -e` snippet — now
refuses by default, naming the escape hatch in its error.

The daemon's declaration is deliberately a **code call**, not an env var: an ad-hoc script's ambient
environment can never flip it, only a statement inside `index.ts` can. This also means the daemon boot is
never identified by sniffing its entry-script path (`dist/index.js`) — that path differs across the npm
`loomctl` package layout, the CLI, and the supervisor, and sniffing a path is spoofable in the wrong
direction (anything with that same path would also be treated as the daemon).

A hermetic test or script that sets its own `LOOM_HOME=<temp>` never reaches any of this: the guard's
first check compares the caller's path against the real prod path and returns immediately for every
non-default home.

**The comparison is realpath- and case-normalized (card 45fba6cf's Code Review finding).** A bare
`path.resolve` string compare is case-SENSITIVE, but Windows paths are not — a differently-cased
`LOOM_HOME`, or an explicit path typed in a different case, named the same real file without matching the
literal `REAL_PROD_DB_PATH` string. `normalizeForProdDbCompare` resolves both sides through
`realpathSync.native` when the path exists (so a symlink/junction/subst/8.3 alias pointing at the real
prod DB also matches), falls back to `path.resolve` when it does not (a fresh install with no DB file yet),
and folds case on win32 only.

## Do not

- Do not replace `declareDaemonProcess()` with an env var the daemon sets on itself — that reopens the
  exact hole this closes, since any ad-hoc script could set the same var on itself.
- Do not reintroduce an env-var opt-in (`LOOM_ALLOW_PROD_DB` or any successor by any name) — see the
  ambient-propagation reasoning above. The opt-in is a Db constructor option, full stop.
- Do not let a test marker be overridable by `declareDaemonProcess()` or an opt-in — the precedence order
  above is intentional defense in depth; a test should never touch the real prod DB under any flag.
- Do not compare `file` against the real prod path with a bare string/`path.resolve` equality check again
  — go through `normalizeForProdDbCompare` on both sides, or a differently-cased/aliased path silently
  bypasses the guard.
- Do not add a new DB-opening call site (`new Db(`, or a raw `new Database(` against `DB_PATH`) without
  classifying it against this guard first: daemon (needs `declareDaemonProcess()`), explicit human opt-in
  (needs `allowProdDb`), or structurally never-prod (bypasses `Db` entirely — `backfill-transcripts.mjs`
  is read-only; `db-backup.ts` opens read-write for its online-backup/WAL-recovery API but is never-writes
  — it only ever runs same-process as the live daemon and is carded separately for its own guard).
