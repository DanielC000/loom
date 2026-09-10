# 062fa934 — `deploySignatureMismatch` is checked before `supervisorChanged` in the live-claim ladder

## Narrative

Card 062fa934 ordered the two caveats `resumeFleetOnBoot`'s `liveClaim` construction can apply to the
"your merged code is now LIVE" nudge. `deploySignatureMismatch` is checked FIRST, ahead of
`intent.supervisorChanged`, because it is a strictly stronger doubt: a turbo cache-replay signature
(see `deploy-staleness.ts`'s module doc) means this process's OWN build identity can't be trusted at
all — a caveated "code is live EXCEPT the supervisor" claim would still be asserting the one thing now
in question (that the running process's build actually is the merged code). So a mismatch pre-empts
the weaker, more specific `supervisorChanged` caveat rather than being checked after it.

This gates the CLAIM text, not the restart itself — the restart already happened either way. WHO
reads this and WHEN: the requesting manager/platform Lead, in this exact post-`daemon_restart` nudge,
every time this process's own `resumeFleetOnBoot` runs (the only place this codebase asserts "your
merged code is live" to an agent). Per the card's DoD, this must NOT become a refusal — only the
ASSURANCE that follows the restart is withheld, never the restart itself.

## Do not

- Do not check `intent.supervisorChanged` before `deploySignatureMismatch` — a signature mismatch is
  the strictly stronger doubt and must win the ladder.
- Do not turn this into a refusal of the restart — the restart has already happened; only the "your
  code is live" assurance that follows it is ever withheld or caveated.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `resumeFleetOnBoot`'s `liveClaim`
construction: line 4766, as of this tranche's HEAD (tranche 13).
