# Resume doc, vault taxonomy, and project memory — detail

Read this when you create or move a vault note, or before you write to project memory. The core doctrine
(loop, step 8) keeps the resume-doc rules (size budget, where it lives, verify a handoff before you act on
it, record merged work by mainline identity). Rotation mechanics: `resume-doc-rotation.md`; memory tool
mechanics: `project-memory.md`.

   **Size budget + rotate-and-archive; never lose old notes.** Keep the ACTIVE doc inside ONE `Read`
   page: target ~150 lines, hard-cap ~400 lines (~40KB). Count lines from the `Read` tool's own line
   numbers or the byte size (a shell line-count may skip empty lines). Carry forward only CURRENT
   state. **Check size BEFORE each rewrite**: near the hard-cap, ROTATE FIRST (move the current doc to a
   dated archive sibling, start a FRESH active doc with only live state), then write; never trim-and-lose
   old notes. Rotation procedure and archive naming: `references/resume-doc-rotation.md` (under this
   skill's directory); read it the first time a rotation comes due.

   **Record merged work by its durable MAINLINE identity, not a branch SHA.** For a SOLO confirm,
   record the mainline squash-commit SUBJECT (= the card title; for a `merge_batch` landing there is no
   single title-derived subject, so use a content grep). The squash makes a NEW commit, so the old
   branch SHA is never on mainline and a later SHA check reports a false "not merged"; a
   `git log --grep "<subject>"` is reliable.
   **Date-stamp load-bearing state you record** (`verified: <date> against <mainline>`) so a successor
   reads its age.

   **If `recycle_me` returns `halted:true`, you were NOT retired — call `recycle_reattempt`** (same self-scoped shape, plus a required `handoffNote` written as carefully as a real handoff) once your successor has reached its first turn: if the still-split categories clear, it delivers your `handoffNote` and **retires you**; if the successor has died (and isn't recoverable), it reclaims everything back onto you, and then you're free to recycle cleanly afterward.

   **Verifying a handoff before you restate it (full text of the core's rule).** A handoff (your resume doc, or a worker recycle handoff) is a **hint, not the source of truth**: where
   it conflicts with the **live board + code**, those win. **Before you act on OR RESTATE any
   load-bearing claim from a handoff, memory, or doc, verify it against the artifact (git / board /
   code)** with one cheap grep or `tasks_list`; restating stale state hides its age behind your
   confidence. **In particular, before you dispatch a build, or file an owner go/no-go for one, for
   work a handoff calls un-built, confirm against `git log`/`git merge-base` that those commits aren't
   ALREADY on mainline.** The same applies to a card scoped from an eval or inference of a "missing"
   capability: confirm the feature isn't already merged before spawning a builder.

   **Other vault notes: shallow taxonomy, not flat.** Your resume doc (and any note the project's
   `CLAUDE.md` pins by exact path) stays at the vault root; **every other note goes in a one-level
   taxonomy folder** named in the project's `CLAUDE.md` **"Vault structure"** section (per-project
   data, never baked in here). Maintain an **`_Index.md`** at the vault root: read it to locate a note
   instead of Globbing or `find`/`ls`, and add/update the note's line when you create or move one.
   Wikilinks resolve by note name, so moving a note never breaks a link.

   **Project memory: the SHARED nugget store, distinct from your resume doc.** `memory_write` writes a
   project-scoped note SHARED across EVERY agent/session and auto-injected into each kickoff. Capture a
   durable cross-session fact any future agent should have (a verified invariant, a load-bearing
   gotcha, a settled decision + why, a "this is already done/closed" fact; if it has a decision record,
   a one-line pointer beats restating it). **Query it too** (`memory_read`/`memory_list`) when a
   decision might already be settled. **Read `references/project-memory.md` (under this skill's
   directory) BEFORE your first memory call**: the `memory_*` tools are deferred with exact param names
   (a guessed param is silently stripped) and updates are version-gated. **A note touching an owner
   gate (pending approval, authorization, spend) records the REQUEST ID + its STATE in asking voice**
   ("PENDING request `<id>` asks the owner to authorize X"), never the decided form, which becomes false
   authority once it outlives the pending state; later readers check the LIVE state via the
   non-consuming `task_requests_list` / `task_request_get`. **Also pass that id via `memory_write`'s
   `requestIds` param**: every read then re-resolves it and appends `[linked request <id>: <STATE> as
   of <date>]`. **Your engine's own auto-memory directory is unreachable for this role**: record
   durable facts with the project memory tool or your resume doc, and treat any auto-memory index
   injected at session start as possibly stale.
