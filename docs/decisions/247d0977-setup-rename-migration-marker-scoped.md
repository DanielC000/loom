# 247d0977 — the legacy home rename migration stops the moment the setup marker exists

## Narrative

`seedSetupProjectRename` (`packages/daemon/src/setup/seed.ts`) is the one-shot boot migration that
renames an existing install's reserved setup home from the legacy literal
(`LEGACY_SETUP_PROJECT_NAME`, "Getting Started") to the current name (`SETUP_PROJECT_NAME`,
"Platform") — see [[db1e4bb8-setup-home-rename-must-run-before-seed]] for why it must run before
`seedSetupHome`.

Before this card it identified "the setup home" purely by NAME — `hasReservedProjectNamed` /
`getReservedProjectByName` against the two literals — never by the stable `setup.homeProjectId`
marker (card `a47dd144`) every other resolver in this file already uses. That name-only check
produced two failure shapes, both human-triggered (from the CR of `5dff8d08`, which made every
other call site in this area marker-aware):

- **(a)** A human renames the reserved PLATFORM home to "Getting Started" and renames the setup home
  away from "Platform" to something else. The next boot's name match finds the platform home (now
  literally named "Getting Started") and renames IT to "Platform" — colliding with/blinding the
  platform resolver, even though neither home's own marker ever moved.
- **(b)** A human deliberately renames the setup home itself to "Getting Started" (a legitimate
  reserved-project edit — only repoPath rebind/archive/delete are refused for `p.reserved`). Every
  following boot's name match finds that SAME row again and renames it straight back to "Platform",
  permanently overriding the human's own edit.

Both shapes share one cause: the function treats "currently named like the legacy literal" as
"needs migrating", but once `setup.homeProjectId` is stamped (at `seedSetupHome` creation, or
backfilled by `resolveSetupHome`'s own name-match fallback) the one-shot migration this function
exists for has ALREADY happened — any row the marker points at is already the live, canonical setup
home, whatever it's currently named. A later rename of that row (by anyone, including back to the
legacy literal) is live state, not legacy state.

The fix: check `db.getMeta(SETUP_HOME_PROJECT_ID_KEY)` FIRST. If stamped, return `null`
unconditionally — no name is ever inspected, so neither a swapped platform-home name nor a
deliberate revert is ever touched. Only when the marker is genuinely absent (an install that
predates it entirely) does the function fall through to the original name-scoped match — and even
there it now also excludes the id already stamped as the PLATFORM home's own marker
(`PLATFORM_HOME_PROJECT_ID_KEY`), so a legacy-named row that's actually the (already-marked)
platform home can never be mistaken for the setup home in that fallback path either.

## Do not

- Do not derive "this migration is already done" from the row's CURRENT name — derive it from
  `setup.homeProjectId` being stamped. The marker, not the name, is what "already migrated" means
  once it exists.
- Do not widen the pre-marker fallback match beyond the exact legacy literal, beyond `reserved=1`
  homes, or drop the `home.id !== <platform marker>` exclusion — any of those can mis-identify the
  platform home as the setup home in the one window (no setup marker yet) this function still does
  a name match at all.
- Do not treat a renamed setup home (to the legacy literal or anything else) as something to correct
  once its marker is stamped — that is a user edit, not drift to repair.

## Source

Card `247d0977` ("fix(setup): make the legacy home rename migration marker-aware"), discovered from
the CR of `5dff8d08` ("fix(daemon): resolve the reserved homes by id marker at every call site").
