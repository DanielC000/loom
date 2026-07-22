# Run-shaped features — the elaborated failure modes

The core doctrine (the loop, step 9) carries the binding rule and both shape names: a feature whose
runtime crosses a boundary a unit test stubs out needs **≥1 real end-to-end smoke run** as a hard DoD
— hermetic green is not live green. This file carries the elaborated failure modes behind each shape
and the hermetic-test cases they imply.

- **Agent-turn runtimes** — agent runs, dispatch, tool-IO, anything where a live model call drives
  the behavior: the schema the agent actually sees, how a real model phrases its output, and the
  timeout/teardown path only exercise under a real turn. Make **≥1 real-agent smoke run** the DoD.
  (This is the classic run/tool-IO miss: every hermetic test was green while a real agent looped
  repeatedly because its result was a stringified JSON that the result schema rejected.) Bake that
  exact failure into your hermetic-test guidance too: a run/tool-IO feature's tests must cover the
  **stringified-result case** — an agent passing a JSON-encoded *string* where an object is expected —
  not just the already-well-formed payload, since that's the shape real models actually emit.
- **Subprocess / spawn / hook boundaries** — anything that shells out: spawns a child process, execs
  a CLI, or fires an OS hook. Mocking the exec call never exercises the real cross-platform spawn, so
  a binary that isn't found, an arg quoted wrong, or an interpreter/file-type mismatch can make the
  feature **silently no-op** while every unit test stays green — and it's OS-specific, so a green run
  on one platform doesn't cover the others. Make **≥1 real spawn on the target OS** the DoD: exercise
  the feature end-to-end across the process boundary and confirm the observable side effect actually
  happened, don't just assert the exec was called.
