# Requests inbox — request types, attachments, and changing a pending ask

Read this when you file a `permission`, `credential`, or `notice` request, attach an image/screenshot to
one, change or withdraw a pending ask, or read an `escalation_status` result. The core doctrine (the
autonomy section) carries the escalation bar, the "never a chat menu" bright line, and the litmus; this
file carries the per-type mechanics. The two lead types (`decision`, `input`) stay in the core.

## The remaining request types

  - **`permission`** — ask to be authorized for an irreversible/outward/spend action: `action` (REQUIRED) describes it; optional `scope` (`"once"`/`"standing"`) + `expiresAt` are your REQUEST, and the human may grant a different scope/expiry, or none. It is **not a second gate** — filing it blocks nothing, so if the action must WAIT, hold it yourself until you `question_pull` an approval. **ADVISORY ONLY:** `question_pull`/`task_request_get` surface the human's ACTUAL decided `{scope, expiresAt, lapsed}` (`lapsed` derived at read time), but Loom never enforces or revokes a standing grant. Re-check `lapsed` yourself before treating an old "standing" answer as live, most of all across a `worker_recycle`/manager-recycle, where a successor otherwise inherits a belief instead of the grant state. **An approval is an AUTHORIZATION, not evidence the write happened:** when the authorized action is itself a human-only write you can't verify (e.g. a setting only a person can change), `approved:true` means they said yes, not that it landed. If your platform's `question_ask` accepts a structured fulfilment target, declare it at ask time so the read side can OBSERVE the write; an undeclared target is an honest `"unknown"`, never a guess.
  - **`credential`** — ask for a secret under a **never-echo** model: you NEVER receive the plaintext, only an ack that it's provisioned (optionally under the `envVar` you name). Use it via your environment/config.
  - **`notice`** — an FYI that needs **no answer** ("the migration landed," "I changed approach on X"). It lands already-answered: never `pending`, never returned by `question_pull`, so don't wait on it. **Rate-limited per agent lineage** (a human-tunable per-project cap): too many in an hour is REFUSED loudly, so consolidate repeated status into fewer notices. `supersedes` doesn't help (a notice is never pending). **Workers relay through you:** `question_ask` isn't on a worker's surface at all; if a worker's progress is worth the owner knowing, YOU file the notice, naming the worker in the text.

  **Showing the human a finished image, mockup, or screenshot? Pass it as a structured `attachments` param (every type, including `notice`), not as a path typed into `body`.** If your platform's `question_ask` supports it, give `{path, label?}`: an absolute path under a root your platform recognizes as yours (a project repo, a worker's worktree, a shared project work dir, a docs/notes vault; check what it allows). It copies the file somewhere durable; a bare path in `body` is just text the human must go find, and it dies when the worker's worktree is cleaned up. A relative path, or one outside an allowed root, fails the WHOLE ask, so resolve to an absolute path first.

## Changing or withdrawing a pending ask

- **The owner answered a still-pending ask live in chat? That's an ANSWER, not a moot ask** — call `question_resolve(questionId, chosenOption?)` in that same turn instead of `question_cancel`: history records it **answered**, with the owner's own words captured verbatim as the note (always server-captured; you never write or paraphrase it). For a `type:"permission"` ask this is asymmetric with an inbox answer: chat has no scope/expiry picker, so whatever the owner said lands as free text in the `note`, `decidedScope`/`decidedExpiresAt` stay null and `lapsed` reads false. Read the `note` for the actual scope/expiry.
- **A still-pending ask that needs to change is a THREE-WAY choice — pick by what actually changed:**
  - **Still the right question, content needs correcting** (fresher details, a fixed path, a broadened option list): `question_amend(questionId, {title?, body?, options?})` updates the row IN PLACE and re-notifies the human; at least one field, and `options` only on a `type:"decision"` ask. **This is the default** for changed wording or details; prefer it over cancel-and-refile, which buries the still-correct original in history.
  - **The ask is moot, or replaced by a DIFFERENT question:** `question_cancel(questionId, reason?)` withdraws your OWN still-pending ask (never another agent's) into a retained history entry carrying your reason. If you know exactly which pending ask the new one replaces, pass `question_ask({..., supersedes: "<questionId>"})` to cancel it atomically while filing the new one (an explicit id you name, never a guess). The new ask is filed even if the supersede is refused; check the response's `supersede` field.
  - **The owner answered live in chat:** an ANSWER, not a moot ask; see `question_resolve`, above.

  All three apply only to a still-`pending` ask in your OWN agent lineage; an already-answered/consumed/cancelled one is refused (an answer the human gave can never be discarded or rewritten; call `question_pull` instead).

## A present owner, and a transient classifier error

- **A Claude Code "Stage 2 classifier error" ("blocking based on stage 1 assessment") is usually TRANSIENT** — retry the identical action once before treating it as a blocker.
- **Carve-out — a present, actively-answering owner.** When the owner is **demonstrably in the conversation, answering you in real time**, act on that live chat answer for an ordinary REVERSIBLE decision without round-tripping a durable `question_ask`. File the durable Request only when you're about to **PARK** on the answer (stop, recycle, or scroll away before it lands). **The irreversible / outward / spend category is exempt:** it files a `question_ask` on first surfacing, present owner or not.

## Reading an escalation result

- **`escalation_status`'s `triaged` is not `resolved`, and not "still broken" either — read `triagedTo`.** `triaged` means the Lead verified your escalation and filed the fix where `triagedTo` names; it does NOT mean the fix landed. `resolved` is reserved for a fix the Lead's board can prove shipped. To know whether it shipped, follow `triagedTo` and check yourself.
