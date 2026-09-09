# 22629cb2 — `RepoRegistryEntry.noGateByDesign` composes with `Project.noGateByDesign` by OR, never by layering

## Narrative

Card 22629cb2 is the per-entry follow-up to `Project.noGateByDesign` (card 58b0bb60): the same deliberate no-build-gate declaration, additionally scoped to just one registry entry. When true, the per-merge "unverified: no gateCommand" warning is suppressed for merges targeting that repo, even when `Project.noGateByDesign` is false.

The two flags compose with OR, not with layering/inheritance. `Project.noGateByDesign`'s existing behavior is unchanged by this field's introduction: it still suppresses the warning project-wide, for a merge into the primary repo or any registry entry, exactly as it did before this field existed — a project declared entirely gateless stays entirely gateless. The per-entry field is a narrower, independent opt-out layered on top for a single entry: setting it never touches `Project.noGateByDesign` or any other entry, and — because the project-level flag is checked separately — clearing it never re-enables a warning the project-level flag is also suppressing. Concretely: a registry entry's flag can never suppress the primary repo's warning (the primary has no registry entry to read this field from), and can never suppress a sibling entry's warning (each merge only ever reads its own entry's flag).

Default/omitted is `false` (still warns, subject to the project-level flag as today) — additive, so every existing entry is unaffected. Same human-only trust posture as the rest of `RepoRegistryEntry`/`repos`: no agent MCP tool ever declares this key (it rides inside `repos`, which is itself never agent-settable).

## Do not

- Do not read the two `noGateByDesign` flags (project-level and per-entry) as layered/inheriting — they compose with OR, each independently checked; clearing one never re-enables a warning the other is also suppressing.
- Do not expose `noGateByDesign` on an agent-facing write surface — it rides inside `repos`, which is itself never agent-settable, same trust class as `gateCommand`.

## Source

Inline comment in `packages/shared/src/types.ts` (`RepoRegistryEntry`'s interface doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
