# 687d2a47 — gitignore-parser/tracked-check over-generation fixes

## Narrative

Four findings, all about `gitignoredTopLevelNames` (parses a root `.gitignore` for watcher-exclusion CANDIDATES) or `gitTrackedTopLevelNames` (the git-query SINK deciding which candidates git already tracks) wrongly treating a genuinely-tracked, history-bearing path as safe to stop watching.

### Finding 1 — a `:`-leading `.gitignore` line

A one-line `if (lineRaw.startsWith(":")) continue;` in the parser (cheapest, matches its own "unknown → leave watched" doctrine) was rejected in favor of the sink: finding 3 below already forces `gitTrackedTopLevelNames` to wrap every candidate in pathspec magic (`:(icase)`), and folding `,literal` into that wrapper closes finding 1 for free, with no separate parser rule to keep in sync.

Without the wrapper, a candidate starting with `:` is git pathspec "magic" (`:!foo`, `:(exclude)foo`, …), not a literal name — live-verified: with `_external/a.md` tracked, `git ls-files -- _external ':!'` returns EMPTY (exit 0) for the WHOLE batched call, because `:!` deselects everything. A `.gitignore` containing both `_external/` and `:!` would silently report `_external` as untracked and offer it for exclusion. `:(icase)` alone closes this — live-verified batched: `_external` and `Notes` (case-differing) both still resolve correctly with a bogus `:!` candidate in the same call, with or without `,literal`, because each `:(...)`-wrapped pathspec's magic is scoped to that one pathspec. `,literal` stays as unreachable belt-and-braces — it disables wildcard reinterpretation, but the parser already rejects any line containing `* ? [ ] \`, so no wildcard can reach this call.

### Finding 2 — a `name/`-form line is git's directory-only pattern

Live-verified: with `.gitignore` = `thing/` and a top-level FILE named `thing`, `git check-ignore -v thing` exits 1 — NOT ignored; only a same-named DIRECTORY is ignored. The parser used to strip the trailing slash unconditionally, so the exclusion regex built from the result also matched a bare file of that name — over-excluding a top-level, extension-less FILE sharing a `name/` entry's name.

Requiring `name` to CURRENTLY be a real directory closes the plain-file case, but "real directory" must be judged by `fs.lstatSync`, not `fs.statSync` (live-verified on WSL Ubuntu 22.04/git 2.34.1, Windows can't create the fixture): an UNTRACKED symlink to a directory is NOT ignored by a `name/` pattern (`git check-ignore -v thing` exits 1 for `thing` → `realdir/`, vs exit 0 for a real directory) and `git add .` DOES stage it — but `fs.statSync` follows symlinks and reports it as a directory, so a `statSync`-based check would over-exclude live, staged content. `fs.lstatSync` correctly reports the symlink as not-a-directory.

Accepted, priced-out cost: a Windows junction IS ignored by git's `name/` pattern but `lstatSync` also reports it as not-a-directory, so its candidate is never generated — under-generating (extra watched handles), never over-generating. Do not special-case junctions back in — Node's `fs` has no portable way to tell "junction" apart from "symlink to dir" without shelling out, and reclaiming those handles reopens the over-generation this fix closed.

### Finding 3 — `core.ignorecase` (default TRUE on Windows and macOS)

`.gitignore` matching honors `core.ignorecase`; plain `git ls-files` pathspec matching does NOT, live-verified — `.gitignore` = `Notes`, tracked `notes/b.md`: `git check-ignore -v notes/new.md` exits 0, but `git ls-files -z -- Notes` returns EMPTY (`-- notes` finds it). A scoped `git -c core.ignorecase=true ls-files -- Notes` still returns EMPTY — the config knob doesn't reach pathspec matching; only `:(icase)Notes` (live-verified) does. A directory case-renamed on a case-insensitive filesystem (index `Notes/b.md`, disk `notes/`, `.gitignore` says `notes`) would otherwise miss the tracked-check while the case-sensitive exclusion regex still matches on-disk `notes` — silently dropping history for tracked content on an ordinary folder rename, no exotic `.gitignore` line needed.

Lowercasing the returned first-segment names (paired with lowercasing the candidate at the `safeToExcludeNames` comparison) is still needed alongside `:(icase)`: icase finds a case-differing tracked entry, but the returned path keeps its own on-disk casing — the membership check still needs both sides folded to the same case.

### Finding 4 — `warnIfLarge`'s zero-entry tripwire is not a general backstop

NOT a tripwire for "any future cause of the same failure shape" — it only catches a scan that dies while the matcher STILL ADMITS top-level content. Real blind spot: an OVER-BROAD matcher (excludes every top-level name) defeats it completely, because `hasUnexcludedTopLevelEntry` reuses that same matcher — chokidar reporting zero entries AND the discriminator agreeing "nothing unexcluded exists" is silent agreement, not a warning. An over-broad matcher is this card family's own primary failure class, so this tripwire is not a backstop against it.

## Do not

- Do not add a source-side `:`-leading skip to the parser — the fix belongs at `gitTrackedTopLevelNames`'s pathspec wrapper, where it's already required for finding 3.
- Do not switch `name/`-form directory detection from `fs.lstatSync` to `fs.statSync` — that reopens the symlink-to-directory over-exclusion this fix closed.
- Do not special-case Windows junctions back into the directory candidate set — there is no portable `fs` way to distinguish a junction from a symlink-to-dir without shelling out.
- Do not rely on `git -c core.ignorecase=true` as a substitute for the `:(icase)` pathspec wrapper — the config knob does not reach pathspec matching.
- Do not treat `warnIfLarge`'s zero-entry warning as proof the watcher is healthy when it stays silent — an over-broad matcher silences it too.
