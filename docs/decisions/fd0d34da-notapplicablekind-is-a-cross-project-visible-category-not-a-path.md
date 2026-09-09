# fd0d34da — `EmitCompareNotApplicableKind`: a cross-project-visible category, never a path or message

## Narrative

`EmitCompareNotApplicableKind` (card `fd0d34da`) is a coarse, PATH-FREE classification of *why* `EmitCompareGateResult.notApplicable` is `true` — set ONLY alongside `notApplicable:true`, never alongside a `notReducible` (`false`) verdict. It exists because `reason` (the human-readable string this sits beside — for several of these reasons it embeds a repo-relative path) is on `gate_status`'s cross-project redaction list, so a manager reading a FOREIGN project's op cannot see `reason` at all: without this field a foreign `notApplicable:true` row carries no more information than the bare boolean. This one is safe to leave VISIBLE cross-project — every value names a CATEGORY of reason, never a path/filename/error string.

- `"repo-out-of-domain"` / `"path-out-of-scope"`: the two ways the classification loop's own catch-all ("path outside emit-compare scope") can be reached. `"repo-out-of-domain"` is a claim about the REPO, not this diff: the repo's own tree at `ref` has NONE of the four scope directories `isEmitCompareInScopePath` tests, checked via a dedicated `git ls-tree` (Code Review, card `fd0d34da` — a diff-only check was insufficient and asserted this confidently wrong on a real Loom-shaped merge) — meaning the predicate can never decide ANY diff on this repo. `"path-out-of-scope"` covers BOTH remaining shapes, which share the identical actionable fact ("the predicate applies to this repo, just not — fully, or at all — to THIS diff"): the diff DOES touch an in-scope path elsewhere, OR the repo's tree has one of the four scope directories even though this particular diff doesn't touch it.
- `"harness-config-unavailable"`: this diff's own `scripts/test-daemon.mjs` (`EXCLUDED_DIR_NAMES` / `NOT_HERMETIC`) couldn't be loaded — expected on a shipped end-user install, which never ships that script.
- `"typescript-unresolvable"`: this whole mechanism's own `typescript` dev-dependency isn't resolvable — also expected on a shipped end-user install.
- `"git-operation-failed"`: a git read failed (the diff itself, a before/after `git show` for a changed compiled file, or the `"repo-out-of-domain"` `git ls-tree` check above) — a mechanism failure, proves nothing about reducibility either way. Deliberately reused here rather than a dedicated kind: an unresolvable domain check must NEVER fall back to a confident (and possibly wrong) `"repo-out-of-domain"`.
- `"empty-diff"`: the diff between the two refs is empty — nothing to prove inert from.
- `"unparseable-diff"`: a `--name-status` line didn't parse into `<status>\t<path>` — the same mechanism-failure bucket as `"git-operation-failed"`, kept distinct because it names a different failure surface (a malformed line, not a failed git invocation).

## Do not

- Do not put a path, filename, or error string into a NEW `EmitCompareNotApplicableKind` value — every value must stay a CATEGORY, since this field is deliberately left unredacted cross-project unlike `reason`.
- Do not fall back to `"repo-out-of-domain"` when the domain check itself is unresolvable — use `"git-operation-failed"` instead; a confidently-wrong domain claim already caused a real incident on a Loom-shaped merge.
- Do not set this field alongside a `notReducible` (`false`) verdict — it is defined ONLY for `notApplicable:true`.

## Consequences

A manager reviewing a foreign project's gate-skip decision can see WHY it was skipped (a category) even though the human-readable `reason` string is redacted cross-project, closing what would otherwise be an opaque `notApplicable:true` with zero diagnosability.

## Source

Inline comment in `packages/daemon/src/git/worktrees.ts`, `EmitCompareNotApplicableKind`'s own doc comment (~line 2816), as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
