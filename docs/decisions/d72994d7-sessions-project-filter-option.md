# d72994d7 — the live-sessions project filter is not derived from the live sessions alone

Anchored at `packages/web/src/lib/sessions.ts` › `projectFilterOptions`. Found by the `f3b18f27` worker (the Atlas Sessions quick-start) and filed as out of its scope.

## The defect

`pages/Terminals.tsx` built its Project `<select>`'s options from the live session list:

```ts
const projectNames = useMemo(() => [...new Set(live.map((s) => s.projectName))].sort(), [live]);
```

That is correct only while the selected value happens to name a project with a live session. A `<select value="X">` whose options contain no `X` does **not** render empty — the browser falls back to the **first** option, which on this page is the standing `All (N)` entry. So:

- the **Atlas project Sessions tab**, which mounts this page pre-selected to its own project (`<Terminals projectId projectName>`), drew `All (0)` whenever that project happened to be quiet — reading as *unfiltered* over a grid that was in fact filtered to the project;
- the **classic god-eye `/terminals`** has the same defect by the same mechanism, reachable a different way: pick a project, watch its last session exit, and the control silently starts claiming `All (N)` while `filter` still holds the project. Same root cause, same fix, no separate code path.

The React state was never wrong in either case. Only the rendered option list was short, which is why the page's own grid (`No running sessions.`) stayed truthful while the control above it did not.

## The decision

Options are the live set **plus** a `held` list of names that must stay offered whether or not a live session names them, passed by the call site:

```ts
projectFilterOptions(live, [projectName, filter])
```

The two `held` sources are **not** redundant, and neither substitutes for the other:

- **the scoped project name** (`projectName`, the Atlas tab's pre-selection) must stay offered *after* the reader widens the filter to All. Once it is no longer selected it is the one option the live set can never re-derive, so without it going back to a quiet project is a dead end — a missing destination, not just a mislabelled control;
- **the current filter value** (`filter`) is the god-eye page's own form of the defect above. It has no scoped project to fall back on, so this is the only thing that keeps a selection alive once its last session exits.

Empty and absent entries are dropped rather than drawn as a blank option: `""` is the `All` entry's own value and is never a project name, and `undefined` is both the real god-eye mount (no scoped project) and the real loading state (`project?.name` before the project query resolves). A god-eye mount at rest therefore holds nothing, and its option list is byte-identical to what the old derivation produced.

## Do not

- **Do not re-derive these options from the live sessions alone**, in this page or any other project-filter control. The failure is silent, it only appears in the state where the filter matters most (a project with nothing running), and it presents as a *correct-looking* page rather than as an error.
- **Do not "fix" it by dropping the `All (N)` entry or moving it off the first position.** That would hide the symptom — the browser would fall back to some other option instead — while leaving a selected value with no matching option, and `All` is a real destination the reader needs. Two e2e specs (`sessions-terminals.spec.ts`, `session-harness.spec.ts`) also identify this control *by* that entry's text.
- **Do not add a per-option session count to the project names.** The options have never carried one, and `session-harness.spec.ts` selects by `label: project.name` exactly. The card's "with a 0 count" means the option exists while its count is zero, not that a `(0)` is rendered; the grid's own `No running sessions.` is where the zero is already stated.
- **Do not reach for a sort other than the default lexicographic `.sort()`.** It is carried over deliberately so the existing option order is unchanged for every project that was already listed.
