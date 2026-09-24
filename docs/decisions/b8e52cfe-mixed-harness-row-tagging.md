# b8e52cfe — a fleet/session row badges claude only in a MIXED-harness view

## Narrative

`HarnessTag` shipped (card `8dfaf750`) badging `codex` and nothing else, on an explicit reasoning: claude is the default and the overwhelming majority, `null` and an explicit `"claude"` both spawn the same binary, and badging every row would spend the fleet's scarcest resources — row width and the reader's attention — on a fact carrying no information. Card `ad3157b9` then had to re-engineer `TileTitle`'s identity line because that one ~55px badge overflowed a ~584px grid tile, which is the measured cost of putting a tag on a row at all.

The multi-harness epic (`df1f94b0`) changes the premise, not that reasoning. Once a default-harness setting can put codex and claude sessions side by side in one view, an UNBADGED row stops being self-evidently claude: it is ambiguous between "claude" and "a surface that forgot to badge this row". The disambiguation is only worth its width where the ambiguity actually exists, so the rule is conditional on the rendered set rather than global: `HarnessMixProvider` computes whether the sessions a view lists run more than one LIVE harness, and `HarnessTag` names both only inside such a view.

Two consequences of the shape. The context defaults to `false`, so every call site with no provider above it — the Profiles list and editor (profiles are not sessions), a single-session terminal page (which can never be "mixed" by construction) — renders byte-identically to before. And only `live` rows widen the set: an exited/archived row is history, and letting one flip a whole view into mixed mode would badge every row off a session nobody can act on.

The claude tag takes the MUTED tone rather than a second accent. It is the baseline being spelled out, not a second thing to worry about; codex keeps amber so the row whose behaviour actually differs still reads first at a glance.

## Do not

- Do not badge every session row unconditionally, and do not badge claude in a single-harness view — a constant fact costs row width and buys nothing. Badge claude only where a second live harness makes an unbadged row genuinely ambiguous.
- Do not let a non-live (exited/archived) row widen the harness set: a view must not flip into mixed mode on a session nobody can act on.
- Do not give the claude tag its own accent colour. Muted is deliberate — two accents would read as two alerts.

## Source

`packages/web/src/components/HarnessPicker.tsx` (`HarnessMixContext` / `HarnessMixProvider` / `HarnessTag`) and `liveHarnesses` in `packages/web/src/lib/harnessFields.ts`. Supersedes the "codex-only, deliberately" call-site comments in `components/fleet.tsx` and `components/TerminalCard.tsx`, which now point here.
