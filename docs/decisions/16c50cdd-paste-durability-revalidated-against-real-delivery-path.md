# 16c50cdd — pasted-text durability re-validated against the REAL companion/system delivery path, not just a raw-terminal write

## Narrative

The original durability probe (`test/_probe-paste-resume.mjs`; see `sha:79af3725` for the underlying decision it supports) confirmed a submitted turn's pasted text is fully durable across a `--resume`, but validated that only via a single raw `writeStdin` write mimicking a human raw-terminal paste. It did NOT validate the companion/system delivery path Loom itself uses to inject messages: `enqueueStdin` → `submit()` → `writeChunked()`, which sends the bracket-paste markers as isolated `pty.write` calls rather than one raw write.

Task `16c50cdd` (a cross-project task; this project's board does not hold its body) re-validated the durability claim specifically against that REAL path, via a new probe (`test/_probe-paste-companion.mjs`) that also exercises the queued-while-busy/`drainPending` timing companion messages actually use. The claim still held on claude 2.1.215.

This re-validation matters because the two delivery paths are not obviously equivalent: a single raw write and a sequence of isolated `pty.write` calls for bracket markers could, in principle, resolve differently inside the engine's paste-detection logic. Confirming durability on the real path closes that gap rather than leaving it inferred from the raw-write probe alone.

## Do not

- Do not treat `_probe-paste-resume.mjs`'s raw-`writeStdin` result as proof that the companion/system delivery path (`enqueueStdin`/`submit()`/`writeChunked()`) is equally durable — it needed its own probe (`_probe-paste-companion.mjs`), and did not need re-litigating once run.
- Do not assume this durability claim generalizes past the claude version it was measured on (2.1.215) without re-checking — see `94721f95` for a related claim on the SAME resume-nudge disclaimer that did NOT hold once the version moved.

## Source

JSDoc comment above `DRAFT_LOSS_NOTE` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 88-91 as of this tranche's HEAD (tranche 1).
