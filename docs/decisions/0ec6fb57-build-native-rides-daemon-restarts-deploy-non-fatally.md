# 0ec6fb57 — `build:native` rides `daemon_restart`'s deploy as a third, win32-only, NON-FATAL step

## Narrative

Card `1718416d` shipped the win-job-launcher containment (see its own decision record), but
`daemon_restart`'s deploy rebuild (`orchestration/restart.ts`'s `deployBuildSteps`/`buildDaemon`) never
ran `build:native` — so (a) the containment only existed if someone ran it by hand in the main checkout,
(b) a merged `launcher.cs` fix never went live through an ordinary restart, and (c) a stale or planted
`win-job-launcher.exe` survived every deploy, unlike `dist/`.

The install/build steps the deploy already ran are deliberately FAIL-CLOSED (see CLAUDE.md's "Deploy-
build gate integrity"): a failure there aborts the restart, because it protects the thing a deploy exists
to verify — that the daemon's own code is correct. The native launcher is categorically different: it is
an OPTIONAL containment enhancement with an already-accepted, already-shipped fallback (the pre-card
taskkill-based quarantine path — the daemon's entire behavior before card `1718416d`, and still the
behavior on every non-win32 host and every win32 host that hasn't built the exe). Making a `build:native`
failure deploy-fatal would let an unrelated host/toolchain change (Smart App Control, AV, WDAC blocking
`csc.exe`; the exe being locked because the live daemon still has it open for an in-flight git call at
the moment the deploy runs) brick `daemon_restart` for the WHOLE fleet — every project on the host, not
just this one — which is strictly worse than quietly staying on the taskkill fallback a little longer.
This also matches the owner's own ruling (card `1718416d`) that kept `build:native` out of the
hard-dependency `pnpm build` path for the same reason, one level up.

## Fix

- `packages/daemon/src/orchestration/restart.ts`:
  - `BuildStep` gained an optional `fatal?: boolean` (undefined/true = short-circuits the deploy on a
    non-zero exit, unchanged for install/build; `false` = logged as a warning, deploy continues).
  - `deployBuildSteps` appends a third step, `buildNative`, ONLY when `process.platform === "win32"` —
    `node <absolute path to build-native-launcher.mjs>`, no shell, no PATH reliance (same rationale as
    the "build" step's own `@decision 51522f05`), bounded at `DEPLOY_NATIVE_BUILD_TIMEOUT_MS` (120s — a
    tiny single-file C# compile is normally seconds; this only guards a genuinely wedged `csc.exe`,
    independent of the non-fatal failure posture). Non-win32 keeps returning the exact same 2-element
    array as before this card — nothing new is spawned there.
  - `buildDaemon`'s loop: a `fatal:false` step's non-zero exit never short-circuits, never updates
    `lastOut`/the returned `tail`, and never affects the returned `code` — it is reported SEPARATELY via
    a new optional `nativeLauncherWarning` string, so a native-compile failure can't read as, or mask, an
    actual deploy failure (and a deploy's own success tail still reflects the last genuinely successful
    step, not a confusing "csc.exe exited 1").
  - `build-native-launcher.mjs` itself needed NO change — it already unconditionally recompiles from
    source whenever it runs (no "skip if exe already exists" check) and was already explicitly designed
    as "safe to invoke unconditionally... without gating on platform/toolchain first" (its own header).
- `packages/daemon/src/sessions/service.ts`: the `daemon_restart` tool's synchronous `{restarting:true,
  ...}` response spreads in `nativeLauncherWarning` when `buildDaemon` set one, mirroring how
  `supervisorChanged`/`deploySha` are already conditionally surfaced on that same return — so the
  requesting manager sees the warning on this call, not only in daemon stdout.
- `packages/daemon/test/build-gate-integrity.mjs`: extended in its existing hermetic, fake-runner style.
  `deployBuildSteps`/`buildDaemon` read the REAL `process.platform`, so the test branches on it rather
  than injecting a fake platform — this host (and the merge gate's, per CLAUDE.md) is real Windows, so
  the win32 branch is actually exercised here, and a non-win32 host (CI) exercises the untouched 2-step
  branch for real. Added: the buildNative step's shape (no-shell/absolute-path/bounded/`fatal:false`);
  that a failing buildNative never short-circuits (every step still runs) and the deploy still returns
  `code:0`; that the warning text is set and names the failure; and the inverse control (a succeeding
  buildNative carries no warning at all).

## Do not

- Do not make a `buildNative` failure abort the restart, even "just this once" for a seemingly-worse
  failure mode — the whole point of this card is that NOTHING about this step's outcome may brick
  `daemon_restart`; escalate a genuinely concerning failure via the warning text, not a fatal exit.
- Do not claim a failed compile "always overwrites" a stale or planted exe — it does not. A failure
  leaves whatever was already on disk UNTOUCHED; see the Residuals note on card `1718416d`'s own record
  for the honest version of this claim.
- Do not fold `buildNative`'s failure text into the deploy's own `tail`/`code` — keep it in
  `nativeLauncherWarning` only, so a reader scanning for "did the deploy fail" never has to first rule out
  an unrelated, non-fatal native-compile warning.
- Do not add a "skip if exe already exists" short-circuit to `build-native-launcher.mjs` to "speed up" a
  deploy — always recompiling from source is precisely what lets a merged fix go live and a planted exe
  get overwritten on the next SUCCESSFUL compile; skipping would silently defeat both.

## Residuals (accepted)

- A failed `buildNative` compile is not expected to corrupt a previously-good exe in place — `csc.exe`,
  like most compilers, only writes its output assembly on a fully successful compile — but this was not
  independently verified against a real interrupted/partial-write scenario on this card. `isWinJobLauncherAvailable()`'s plain `fs.existsSync` would not distinguish a corrupt exe from a good one
  either way; the mandatory taskkill fallback (card `1718416d`) remains the backstop regardless.
- The exe-locked-by-the-live-daemon case (the live process still has `win-job-launcher.exe` open for an
  in-flight canonical git call at the exact moment the deploy's `buildNative` step runs) was reasoned
  about but not reproduced under a real concurrent git call during this card's own verification — it is
  one plausible, named cause of a `buildNative` failure, not a confirmed one.

## Source

Card `0ec6fb57`, discovered from card `1718416d`'s own Code Review (`7bba383c`). See
`docs/decisions/1718416d-win-job-launcher-containment.md` for the containment mechanism this deploy step
rebuilds, and its own Residuals section for the matching honest statement of the stale/planted-exe
survival case. Test: `packages/daemon/test/build-gate-integrity.mjs`.
