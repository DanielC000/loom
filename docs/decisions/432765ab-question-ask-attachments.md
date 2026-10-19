# 432765ab — `question_ask` attachments: scope decisions

Card `432765ab`, child 1 of epic `7d1d66ab` (inbox attachments, Direction B · Manifest). Daemon/MCP
foundation only — no serving route, no GC, no web UI (separate sibling cards).

## Threat model — what the path checks ARE and are NOT a boundary against

`resolveAttachmentPath` (`mcp/attachments.ts`) runs several checks, and NONE of them are a privilege
boundary against an asker (manager or Platform Lead) that already has its own host filesystem access
(Bash/Read/Write) — every one of them is MISTAKE/PROMPT-INJECTION HARDENING, full stop:

- **Root containment** (repo/worktrees/work-dir/vault/multi-repo `repos[]`): an asker that already has
  host access to every allowed root can already read and copy a file there with its own tools: this only
  stops a WRONG or INJECTED path from silently reaching outside the roots the asker is supposed to be
  working in.
- **The LOOM_HOME refusal** is the SAME class, not a stronger one — this was corrected after Code Review
  round 3 verified a hardlink bypass and, independently, that the claim "the Lead has no other way to read
  LOOM_HOME" is FALSE: the Lead's own `cwd` IS `LOOM_HOME`, only `SETTINGS_DIR` carries a `Read()` deny
  (`pty/claude-settings.ts`), and Bash is not covered by that deny at all. An asker with Bash can read
  `secret.key`/`loom.db`/anything else under `LOOM_HOME` regardless of this refusal. Its real job is
  narrower: stop a WRONG path (a stray `LOOM_HOME`-rooted value reached via normal containment logic, or
  an injected one) from being attached — not to stop a determined actor who already has a shell.
- **File-identity checks** (hard-link refusal at resolve time, re-validated `dev`/`ino`/`nlink`/type at
  copy time — see "Check ordering" below) exist for a DIFFERENT reason than the two above: they close a
  resolve-then-copy TOCTOU window an attacker could otherwise use regardless of containment/LOOM_HOME.

There is no privilege boundary anywhere in this pipeline. If a future requirement needs one (e.g. "the
Lead must not read `secret.key` even via Bash"), that is a different, much larger problem (sandboxing the
Lead's shell) and is explicitly out of scope here.

## Check ordering (`resolveAttachmentPath`) — fixed, never reorder

1. absolute-only (pure string, no fs call).
2. LEXICAL plausibility against every allowed root's RAW or CANONICAL key (pure string comparison —
   `isProperlyUnder`/`comparisonKey` on `path.resolve()`'d strings; the roots themselves are canonicalized
   once, since they're the daemon's OWN trusted, bounded-count paths, never the attacker-influenced one).
   A target that isn't even lexically plausible under any root is refused HERE — this is what stops any
   absolute path (an out-of-root mapped drive, an NFS/autofs mount, a UNC share) from getting a
   synchronous `realpath` call just to prove it's outside.
3. `canonicalizeForContainment` on the target — ONLY reached once step 2 passed. Its own first move is a
   pure-string UNC/device/NT-namespace-prefix refusal, before it ever calls `fs.realpathSync.native`.
4. precise canonical containment against the roots (closes the symlink/junction-escape case step 2's
   lexical check can't: a target that's lexically under a root but REAL-resolves outside it).
5. the LOOM_HOME refusal (hardening — see "Threat model" above).
6. ONLY NOW does anything touch the filesystem for existence/type/identity — `openAndCheckRegularFile`,
   on the canonical path, fully async (`fs.promises`), never the raw string.

Because existence is never checked until step 6, an "outside every allowed root" refusal (from either
step 2 or step 4) is identical whether or not the path exists — it is never an existence oracle.

**Narrowing accepted by this design**: step 2 only recognizes a target reached via a root's OWN raw
spelling or its OWN canonical spelling — not via some third, unrelated alias of the same real directory
that nothing told the system about. A root specified as a junction, addressed via its real path (or vice
versa), still matches (both spellings are in the cache); an arbitrary third alias does not. This is
deliberate: accepting a target only via a spelling we can cheaply relate to a trusted root is safer than
realpath-ing every candidate just in case it happens to alias one.

## File-identity checks — the hardlink + resolve-then-copy fixes (Code Review round 3)

Two closed holes, both at `openAndCheckRegularFile` (resolve time) and `copyAttachmentWithCap` (copy
time):

- **Hard links.** `realpath` of a hard-linked file is its OWN path — containment and LOOM_HOME checks
  never see the link. VERIFIED: a same-volume hardlink in an allowed root pointing at `secret.key` passed
  every earlier check and got copied. Fixed: `openAndCheckRegularFile` refuses `st.nlink > 1` outright
  ("hard-linked files can't be attached" — this also refuses a pnpm-store file, which is acceptable: a
  legitimate attachment is never a `pnpm`-store-shared file). `copyAttachmentWithCap` re-checks `nlink`
  again at copy time (see next).
- **Resolve-then-copy swap.** `copyAttachmentWithCap` used to re-open the source BY PATH with no
  FIFO/symlink/identity guard — a file swapped in between (attachment[1] changed while attachment[0] is
  still copying, since copies run sequentially after ALL paths resolve) reopens the exact FIFO-wedge and
  symlink-into-LOOM_HOME holes the resolve-time checks exist to close, just one step later. Fixed WITHOUT
  holding file descriptors open across the whole pipeline: `resolveAttachmentPath` returns the validated
  file's `dev`+`ino` (from its own `fstat`); `copyAttachmentWithCap` re-opens with
  `O_NONBLOCK_IF_POSIX | O_NOFOLLOW_IF_POSIX`, `fstat`s that SAME handle, and requires
  `isAcceptableAttachmentStat` AND `nlink === 1` AND the SAME `dev`+`ino` as resolved — any mismatch
  refuses with "file changed after validation" before a single byte is read, no partial copy left behind.

**Residual, narrowed (not eliminated) by the fix above**: between `openAndCheckRegularFile`'s `close()`
and `copyAttachmentWithCap`'s `open()`, the ORIGINAL file could in principle be deleted and a NEW file
created that happens to reuse the exact same freed `dev`+`ino` pair before the copy-time check runs — this
is a real, if extremely narrow, POSIX inode-reuse race, not the practical junction/hardlink swap the fix
above actually closes. Accepted: closing even this would need the resolve-time fd held open across the
entire pipeline (defeating the point of a cheap identity re-check), and winning this race requires
precise timing control an asker with ordinary tool access has no particular advantage at over the daemon's
own scheduling.

## Caps

`attachmentMaxBytes`/`attachmentMaxCount` resolve PER-PROJECT via `resolveConfig` (platform default,
project-level override) — human-only to set either way (see "Do not" below). This is the SAME resolution
shape every other per-project orchestration cap in this codebase already uses (`maxConcurrentWorkers`,
`idleNudgeMinutes`, etc.) — not a special case invented for attachments. The live resolved default is
`shared/config.ts`'s `PLATFORM_DEFAULTS.orchestration` — read it there, not restated here.

## Out of scope (this card)

The Platform Lead's `question_ask` attachments are bounded to its OWN project (`LOOM Platform`'s
`repoPath`/`vaultPath`/work dir/worktrees) — it cannot attach a file from a DIFFERENT project it also
manages. Letting the Lead attach across projects (it is, after all, cross-project by design) is explicitly
deferred to a future card, not solved here. Sandboxing the Lead's own Bash access (the actual boundary a
"the Lead must never read `secret.key`, period" requirement would need) is also out of scope — see
"Threat model" above.

## Do not

- Do not wire `Project.denyGlobs` into attachment path resolution. It is NOT a file-access denylist: its
  only real consumer, `matchAddedDenyGlobs` (`git/worktrees.ts`), matches REPO-RELATIVE glob patterns
  against a MERGE-REVIEW DIFFSTAT to raise an advisory reviewer warning (e.g. the default `mockups/**`).
  Repurposing it as a hard refusal here would block exactly the mockup files this feature exists to let a
  manager attach. Investigated and explicitly rejected (owner/manager ruling 2026-10-19).
- Do not let `attachmentMaxBytes`/`attachmentMaxCount` be settable by the elevated Platform Lead's
  `project_configure` — both are listed in `HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS` (`mcp/platform.ts`),
  same reasoning as `maxNoticesPerHour`: the party these caps govern (the asker) must never be able to
  raise its own ceiling.
- Do not enforce the per-attachment size cap via a pre-copy `fs.stat` check — the source file can grow
  between that check and the copy (TOCTOU; the asker may still be writing it). Enforce on bytes actually
  transferred by the copy loop itself (`copyAttachmentWithCap`).
- Do not accept a relative `attachments[i].path` — absolute only.
- Do not map the absolute store path or the asker's original absolute path onto `Question.attachments` —
  that is the PUBLIC-SAFE projected shape every read surface serializes. Mirrors how `toQuestion` already
  never maps `secret_blob`.
- Do not reorder the check sequence in `resolveAttachmentPath` — see "Check ordering" above; it is WHY an
  "outside every allowed root" refusal can never be used as an existence oracle, and WHY no fs call ever
  sees an out-of-root absolute path.
- Do not check `!isDirectory()` alone to decide a target is attachable — a FIFO is not a directory, and
  opening one without `O_NONBLOCK` blocks forever, wedging the libuv threadpool. Require
  `isAcceptableAttachmentStat` on a handle opened with `O_NONBLOCK_IF_POSIX | O_NOFOLLOW_IF_POSIX`.
- Do not skip the hard-link (`nlink > 1`) refusal at resolve time, and do not let `copyAttachmentWithCap`
  trust a handle it didn't itself open+fstat — see "File-identity checks" above; both checks are
  independently necessary (resolve-time catches the ordinary case cheaply; copy-time catches a swap that
  happens after resolution).
- Do not claim this pipeline is a privilege boundary anywhere, in code comments or in future review
  responses — see "Threat model" above. It is hardening against mistakes and prompt injection.
