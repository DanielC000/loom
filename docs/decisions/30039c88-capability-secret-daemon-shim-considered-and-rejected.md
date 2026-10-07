# 30039c88 — a daemon-fetched shim for capability secrets: CONSIDERED AND REJECTED

## Background

`discoveredFrom 2be634f2` (which rejected moving a capability secret onto claude's own process env — see
that record). This card asked whether a different design — a small Loom shim command that fetches the
real secret ONCE from the daemon over loopback, authenticated by a one-shot nonce bound to the session +
grant, sets it only on the real capability server's own env, then execs it — would close the remaining
pre-`markReady` plaintext-file window without reintroducing `2be634f2`'s own claude-env mistake. This is a
read-only design + measurement investigation (DoD: no product code); it found the window already narrow
and bounded, found the proposed shim does not actually close it, and found the shim nets WORSE on Windows.
**Verdict: don't build.** Investigated, reported, and ruled on by the manager without implementation.

## 1. Today's exposure, measured

**Write site.** `createPty` (`pty/host.ts:7001-7003`) calls `writeSessionMcpConfig(opts.sessionId,
mcpServers)` (`pty/host.ts:7002`) synchronously, BEFORE the real `pty.spawn()` call
(`pty/host.ts:7073`) — fires whenever the assembled `mcpServers` map carries a capability secret or the
per-session `mcpToken` (`capabilitySecrets.length > 0 || !!mcpToken`, true for essentially every real
spawn today per card `280b1e44`). `writeSessionMcpConfig` itself (`pty/claude-settings.ts:337-344`) writes
a tmp file with `{mode: 0o600}` (line 340), `renameSync`s it into place (341), then a best-effort
`chmodSync(file, 0o600)` (342) — that `chmodSync`, and the write-time mode, are both explicitly documented
as a no-op on Windows (comments at lines 303/342); no other code anywhere in this repo sets or restricts a
Windows ACL on this file. It is left at whatever NTFS inherits from `SETTINGS_DIR`'s own ACL —
`SETTINGS_DIR = <LOOM_HOME>/tmp/settings` (`paths.ts:68`).

**Unlink sites**, all via `unlinkSessionMcpConfig` (`pty/claude-settings.ts:359-360`, best-effort):
- `pty/host.ts:7003` — secret-free spawn path, cleans a file a PRIOR spawn left (not this spawn's window).
- `pty/host.ts:7083` — `createPty`'s own catch block, if spawn throws before any process exists.
- `pty/host.ts:11584` — inside `markReady`, the earliest safe point for THIS spawn's own file (per
  `ed0757d6`'s evidence that `--mcp-config` is parsed once, at CLI bootstrap, before SessionStart can fire).
- `pty/host.ts:5301` — pty `onExit`, unconditional backstop (crash before ready, or stop/archive).
- `pty/mcp-config-gc.ts:56` `sweepOrphanedSettingsDirSecrets` — boot-time sweep, final backstop for a hard
  daemon crash that skipped all four call sites above.

**Window length (spawn → markReady), bounded by code, not guessed.** Three constants govern it
(`pty/host.ts:1412,1421,1428`): `READY_FALLBACK_MS` = 20,000ms (spawn-anchored fallback if SessionStart
never fires), `MODE_CYCLE_FALLBACK_MS` = 20,000ms (re-armed from SessionStart's own dispatch once it does
fire), `READY_FALLBACK_ABSOLUTE_CEILING_MS` = 45,000ms (hard ceiling from spawn, card `c469d54e`). Real
measured SessionStart-dispatch latency (778 real fresh-spawn observations on the owner's fleet, cited at
`pty/host.ts:1433-1436`): median ~3.2s, p99 ~10.6s, worst observed 90.4s under host contention — but the
20s spawn-armed fallback fires FIRST (and unlinks via `markReady`) if SessionStart is still pending at
t=20s, so in practice the file is gone at or before ~20s even in a slow-boot case, and typically within a
few seconds in the common case. **Hard ceiling anywhere in the code: 45s.**

**Who could read it in that window.**
- The OWNING agent **cannot**, structurally: the file is parsed by the claude HOST PROCESS before
  SessionStart fires (`ed0757d6`'s live proof — the secret was still usable via the mounted MCP tool
  *after* SessionStart had already deleted the file), and the agent's first-ever turn only runs after
  `markReady` + kickoff delivery — strictly after the unlink. There is no tool-call surface before a first
  turn exists at all.
- A co-resident **codex** session **can**: `createCodexPty` threads no `opts.permission` at all (zero
  matches for `opts.permission`/`SETTINGS_DIR_READ_DENY_RULE` in `codex-host.ts`, re-confirmed for this
  card), and codex's `-s workspace-write` sandbox restricts writes only. **This is already explicitly
  disclosed** — see §3 below.
- A co-resident **claude** session gets `SETTINGS_DIR_READ_DENY_RULE` unconditionally in its own
  `permission.deny` (`pty/claude-settings.ts:421,429-431`), live-verified to block `Read`/`Glob`/
  `Bash(cat)` — but this is a tool-dispatch pattern match, not a filesystem boundary: arbitrary `Bash` CODE
  (`node -e "fs.readFileSync(...)"`) is not blocked by it (`ed0757d6`'s own record says so explicitly).
  That rule is also built from the RAW, unresolved `LOOM_HOME` string, which a junction/symlink alias could
  evade — see §3 below.
- Any other same-OS-user host process outside Loom entirely — not gated by claude's permission system at
  all; POSIX narrows this to the owning UID via 0600; Windows narrows it to nothing beyond default NTFS
  inheritance.

**The capability child's own env holds the secret anyway — the ceiling on what any file-window fix can
achieve.** `resolveCapabilityServer` (`capabilities/registry.ts:454-460`, `@decision 2be634f2` at line 457)
sets the literal secret into the mounted stdio capability server's own `env` block. That CHILD PROCESS
runs for the capability's entire mount lifetime — the WHOLE session, not a short window — on every OS.
POSIX: trivially readable by any same-UID process via `/proc/<pid>/environ` or `ps eww`, ordinary tools,
no privilege. Windows: needs a deliberate PEB read (`OpenProcess`+`ReadProcessMemory`), a higher bar than a
file read, but still a STANDING exposure for the session's full life, not a brief window. **Any
same-OS-user attacker capable of exploiting the brief pre-markReady file window is equally capable of
reading the child's standing env instead, for almost the entire rest of the session** — the file window is
a narrower, shorter-duration instance of an exposure channel (same-OS-user process/file introspection)
that remains open regardless, through a channel that is irreducible by construction (the child must hold
the real value to function). Closing the file window, by any means, caps out at removing the shortest
piece of a strictly larger problem.

## 2. Why the proposed shim does not close the window (and nets worse on Windows)

**Nonce delivery is exposed on the identical terms as the secret is today.** The only place
`resolveCapabilityServer`'s output can carry per-mount data to a shim, without regressing to argv (argv is
visible via `/proc/PID/cmdline`/`ps`/Windows WMI CommandLine — strictly worse, no file-read gate at all),
is the SAME mcp-config.json `env` block the real secret rides in today. A nonce placed there is exposed to
the identical readers, for the identical window, as the secret is today.

**One-shot does not mean race-proof.** "One-shot" only prevents REUSE after a successful redemption — it
does not prevent a RACE. A co-resident reader who can read the file today can read the nonce and hit the
daemon's redeem endpoint before the legitimate shim does. The daemon cannot distinguish the real shim's
redemption call from an attacker's: both are a bearer value over loopback from a same-UID process, with no
other distinguishing signal. Closing that race for real needs binding redemption to the ACTUAL CHILD
PROCESS's identity (not a bearer value) — not uniformly available cross-platform over plain loopback HTTP
(POSIX has `SO_PEERCRED`-style unix-socket ancillary data; a generic loopback TCP HTTP server doesn't get
an equivalent without extra OS-specific plumbing, and Windows has no analogous mechanism for a TCP socket
either). **This is the only design that could actually close the race — out of scope here**: it is a
materially harder, platform-specific, unscoped piece of work (real process-identity verification, not a
bearer-nonce swap), not a detail that falls out of the shim idea as described in the card.

**Daemon restart mid-spawn.** A nonce needs either a durable (DB-persisted) store to survive a restart —
reproducing, for nonces, the exact lifecycle/cleanup problem `ed0757d6` already solved once for secrets —
or a fail-closed "nonce unredeemable → this one capability doesn't mount this spawn" posture, consistent
with existing patterns (`resolveNodePackage`/`resolvePythonVenv` already return `null` → skip-this-spawn on
a cold/unresolvable provision). The fail-closed posture is lower cost, but is still new code and tests, not
free.

**Windows has no true exec, so the shim stays a parent — and that is the central problem.** On POSIX,
`exec()` replaces the shim's own process image in place (same PID); there is no persisting "shim, distinct
from the real binary" artifact once it execs. On win32, `CreateProcess` always creates a genuinely new
child, so the shim must stay alive as a real, persistent OS process (a proxying parent) for as long as the
capability is mounted — i.e. for the WHOLE session. To launch the real binary with the secret in ITS env,
the shim must first hold that same secret in ITS OWN env/memory for that same whole-session duration.
**Net effect on Windows: this does not reduce the standing env-based exposure at all — it ADDS a second
long-lived process holding the live secret** (shim + real child, instead of just the real child), widening
the population of same-OS-user-readable processes rather than narrowing anything. (The secret must reach
the shim via its own env/memory, fetched by the shim itself — never via the shim's own argv, which would be
strictly worse than today, visible to any same-user process with no file-read gate at all.)

## 3. The two side findings — tracking status

**(a) Codex's cross-session read of a live mcp-config.json: already explicitly disclosed.**
`docs/decisions/7955458e-enforce-or-surface-permission-deny-on-codex-spawns.md` names this exact gap twice:
in its Background's item 1 ("**SETTINGS_DIR read-deny**... Denies `Read(<LOOM_HOME>/tmp/settings/**)`,
which holds every live session's hook token and, for a secret-bearing claude spawn, its plaintext
`--mcp-config`") and, more directly, in its own "Residual risk — NOT closed by this card" section,
verbatim: *"A codex WORKER can `cat` another session's plaintext `--mcp-config` secret file out of
`<LOOM_HOME>/tmp/settings/` right now, and the loud `settingsDirReadDeny` disclosure (now routed via
`onCodexIsolationGapDisclosed`, never into the affected session's own input) does not prevent that — it
only names the gap, to the manager, once per lineage. The real fix (per-session directory isolation/ACLs,
or not persisting a plaintext secret readable across sessions in the first place) is its own card,
deliberately not built here."* No further card is needed for this half — it is already a disclosed,
carded-separately residual.

**(b) The raw/unresolved `LOOM_HOME` junction-bypass of `SETTINGS_DIR_READ_DENY_RULE`: FIXED (card
`f2bb9dbe`).** At the time of this investigation it was flagged only in a source comment
(`pty/loom-home-deny.ts:9-12`'s own doc), not tracked as a board card or decision record anywhere —
confirmed via `grep -rn "junction" docs/adr docs/decisions` returning zero hits, and no decision record
under either store named `SETTINGS_DIR_READ_DENY_RULE`'s own junction exposure (the four docs that DO
mention `SETTINGS_DIR_READ_DENY_RULE` — `2be634f2`, `37310431`, `a50b8afd`, `ed0757d6` — never raised this
specific bypass). Card `f2bb9dbe` closed it: `claude-settings.ts` now resolves `SETTINGS_DIR` through the
same `canonicalizeExistingPath` helper the write deny uses and denies both the raw and resolved-real
paths when they differ. See `docs/decisions/f2bb9dbe-settings-dir-read-deny-resolves-junction-alias.md`.

## 4. Cheap hardening not taken now

**Windows applies no ACL to `SETTINGS_DIR` beyond ordinary NTFS inheritance.** Unlike the POSIX 0600 mode
(a real, if partial, restriction to the owning UID), Windows gets nothing beyond whatever the directory's
own inherited ACL already grants — no explicit DACL narrowing the file to the daemon's own user account
was ever applied. This was identified, not built, as part of this investigation: a deliberate
`icacls`/`SetNamedSecurityInfo`-style per-file ACL restriction on Windows (mirroring what `chmod 0600`
already buys on POSIX) is a comparatively cheap, platform-specific hardening that would narrow the window's
Windows-side population without any of the shim's new attack surface or its Windows-side regression — left
unbuilt here because it does not answer this card's own design question (whether to build the shim), and
was outside the DoD's read-only-investigation scope.

## Do not

- Do not move a capability secret onto claude's OWN process env — see `2be634f2`'s own record; unchanged
  by this investigation.
- Do not re-attempt the bearer-nonce shim design (fetch-once-over-loopback, exec the real binary) without
  first adding genuine process-identity-bound redemption — a bearer nonce riding the same mcp-config.json
  file the secret rides in today is exposed on identical terms to the identical readers, and "one-shot"
  does not prevent a same-window race between the legitimate shim and a co-resident attacker.
- Do not build this shim for Windows without accounting for the fact that it must persist as a second,
  long-lived parent process holding the real secret in its own env for the capability's entire mount
  lifetime — this widens, not narrows, the standing same-OS-user-readable population there.
- Do not treat the pre-markReady file window as the dominant exposure — the capability child's own env,
  held for the whole session on every OS, is strictly larger and longer-lived, and is irreducible by any
  design that must still hand the real child process the real value to function.
- Do not read the codex cross-session mcp-config read as untracked — it is explicitly named, with the exact
  quote above, in `docs/decisions/7955458e`'s own "Residual risk" section.
- Do not assume the `LOOM_HOME` junction-bypass of `SETTINGS_DIR_READ_DENY_RULE` is still open — it was
  fixed by card `f2bb9dbe`; see that record for the mechanism and residual.
