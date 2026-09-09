# 23980bbf — fold the resolved health-probe interval into the drift-transition log line itself

## Narrative

A TRANSITION-only log line (see card `545ef479`'s `announceDriftCheckState`) is, on its own, indistinguishable from a low-frequency POLL log — both are sparse lines, and a reader who doesn't already know this line only fires on change can (and did) mis-derive a wait budget from the gaps between occurrences. Card `23980bbf`: folding the RESOLVED `healthProbeIntervalMs` into the line itself — never the hardcoded default constant, since this instance may have been constructed with a test/override seam — is what makes the true poll cadence derivable from the log output alone, without reading this source file.

## Do not

- Do not print the hardcoded default health-probe-interval constant in the drift-transition log line — print the RESOLVED instance value (which may differ under a test/override seam), or the line misleads a reader about the actual poll cadence.

## Source

JSDoc method comment in `packages/daemon/src/codescape/supervisor.ts`, above `announceDriftCheckState` (the card-23980bbf paragraph): originally part of lines 1628-1643, as of this tranche's HEAD. Relocated by card `725511f2` (tranche 1); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
