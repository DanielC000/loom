# ba3c9580 — rename the gate concurrency pin to a Loom-qualified name

## Narrative

Found by the Codescape peer manager, 2026-07-31, from their own instrumentation, not a code read.
Their test executor writes an ndjson row per run recording the gate environment; a run on their
repo came back carrying `"loomTestConcurrencyEnv":"2"` while their suite actually ran at
concurrency 8 — `LOOM_TEST_CONCURRENCY=2` was present in a Codescape gate child's environment, a
variable only Loom's own harness reads, injected unconditionally regardless of project. They asked
what it meant, because it reads like an intended per-gate lane budget, and were one inference away
from clamping their own concurrency 4x downward on a contract that does not exist.

**The mechanism, verified in source before answering the peer:** set in `sessions/service.ts`
(`WORKER_GATE_ENV_OVERRIDE`), applied in `orchestration/gate-runner.ts`'s env spread, and read only
by this file's `Number(process.env.LOOM_TEST_CONCURRENCY) || DEFAULT_CONCURRENCY` — nothing else in
the repo reads it. Scoped to the worker self-check (`run_gate`) path only; a merge gate gets no
override. Pinned to 2 (now 3, see card `2ff32b5c`) specifically to match Loom's own merge gate's
default lane count, so the host-load budget stays `maxConcurrentGates x lanes` — reasoning that is
entirely about Loom's own suite and does not generalise to any other project.

**The defect:** a Loom-private variable, injected into every project's gate child regardless of
project, under a generic-sounding name. Today inert for other projects (their executors ignore it),
but the latent hazard is worse than the noise — if any project's harness ever reads a variable named
this plausibly for a generic test-runner concurrency knob, Loom would silently clamp that project's
test concurrency, and nobody would have decided it; the symptom (a suite mysteriously running at a
fixed low concurrency only under the gate) would be miserable to trace.

**The fix:** rename the variable to a Loom-project-qualified name (`LOOM_GATE_TEST_CONCURRENCY`)
so a collision with another project's own environment variable is structurally impossible, updating
the one reader in the same commit — cheaper than building a per-project opt-in surface, and closes
the hazard completely. Do not simply stop pinning it: the pin exists for a real reason (card
`68920f5b`, an owner decision after the 2026-07-15 incident where a single unpinned gate spiked to
8 lanes and starved the host) — the problem was the variable's name and cross-project scope, not
its existence.

## Do not

- Do not read or set `LOOM_TEST_CONCURRENCY` (the old, unqualified name) — the reader is
  `LOOM_GATE_TEST_CONCURRENCY`; the generic name is exactly the collision hazard this card closed.
- Do not stop pinning gate-child test concurrency to solve this — the pin itself (card `68920f5b`)
  is a separate, deliberate decision protecting the host from a real starvation incident.
- Do not build an agent-writable per-project gate-env surface to scope this instead — env injection
  into a spawned gate child is capability-gated, human-only, same posture as `gateCommand`.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, at the `DEFAULT_CONCURRENCY`
definition (originally ~line 819). Card `ba3c9580`, filed 2026-07-31, merged as commit `4b04957`.
