# a3d5c7f4 — SSH connections: Loom holds the key, the agent calls `ssh_exec`

## Narrative

Owner directive: give agents SSH access to homelab machines without the agent ever holding the private key — "Loom builds the connection and hands it to the agent." The owner's three candidate mechanisms (per-session ssh-agent socket, short-lived CA certs, ControlMaster) all hand the agent a raw, authenticated `ssh` it runs itself.

Measured on this host (Windows): the agent's own Bash tool resolves Git Bash's MSYS `ssh`, which is socket-incompatible with native Windows OpenSSH in both directions — a Node-hosted agent-protocol named pipe worked with native `ssh-add` but not Git Bash's, and a Git-Bash-created Unix socket worked for Git Bash's `ssh-add` but not native `ssh-add.exe`. ControlMaster shares the same client-created-socket shape and was dropped for the same reason, matching the card's own expectation.

More load-bearing than the Windows finding: handing the agent a raw, authenticated `ssh` (any of the three) only participates in the AUTHENTICATION step. Once the session starts, Loom's agent-protocol server is no longer in the data path and cannot see, allowlist, or audit individual commands, enforce read-only mode, or cap output — only a static server-side `authorized_keys command=` can do that, which trades away per-call flexibility.

**Decision:** Loom's daemon is the SSH client itself, in-process (a pure-JS SSH2 library, e.g. `ssh2` — no spawned client-side `ssh`, no client-platform dependency), exposed as a constrained `ssh_exec` MCP tool, structurally the same server-side-dispatch shape as the existing `authenticated_request` tool (`connections/request.ts`, `mcp/server.ts:856-905`). The agent gets a tool call, never a transport. This makes every containment ask (host/port/user/host-key pinning, command allowlist, read-only mode, timeouts, output caps, no PTY/forwarding) enforceable by Loom in one place, with zero dependence on which `ssh` binary exists on which OS.

The private key is envelope-encrypted at rest (`keys/envelope.ts`, same mechanism every other connection type uses) and decrypted server-side only for the duration of one call — never an env var, never a file, never anything the agent's own process can read. Host-key fingerprint is captured and human-confirmed once at connection-create time; any later mismatch refuses the connection. Every call (run or refused) writes an audit event unconditionally. A risky-command pattern list routes through the existing `question_ask(type:"permission")` decision inbox (non-blocking — Loom has no synchronous confirm primitive) rather than a new blocking mechanism; approval is scoped to the exact command text, re-validated on redemption, never a generic "this session is now trusted" flag.

## Containment (condensed)

| Ask | Enforced by |
|---|---|
| Host / port / user pinning | Loom — built from the connection row only, never caller input |
| Strict host-key pinning | Loom — captured + human-confirmed at create; refuse on any later mismatch |
| Command allowlist | Loom, checked before dispatch; an `authorized_keys command=` forced command is optional server-side defense-in-depth |
| Read-only mode | Loom, checked before dispatch |
| Timeouts / output caps | Loom — bounded exec channel, capped stdout/stderr |
| No PTY / forwarding | Loom, by construction (never requested); `authorized_keys restrict` is the server-side backstop |

## Decisions (owner, via the Lead, 2026-11-04)

1. A new SSH connection defaults **read-only ON**; the owner unticks it per connection to allow deploy/restart.
2. **No raw/interactive ssh handoff in v1** — kept as a documented future option only, not built.
3. **One connection per host** — no host-group construct.
4. Ship a **default risky-command pattern list**, editable per connection.
5. **Strip the passphrase at create time**; rely solely on envelope encryption at rest.

Full analysis (current-state code citations, the measured host probes, the full containment detail, audit/confirm design, the owner-facing setup flow, and the 6-child decomposition): `$LOOM_PROJECT_WORK_DIR/a3d5c7f4/ssh-connections-design.md` (not in the repo — a work-dir deliverable).

## Child 1 (store, card f9972a3d) — `getSecretForUse` and the capability-grant guard

The store's generic `getSecretForUse` (used by BOTH `authenticated_request`'s HTTPS dispatch and a P4
capability grant's static env injection) already excluded `oauth2` rows because their secret_blob is a
JSON token bundle, not a raw header-injectable secret. An `ssh` row's secret_blob is the private key — if
`getSecretForUse` ever returned it, `performAuthenticatedRequest` would dispatch it as an `X-API-Key`/
`Bearer` header to an arbitrary HTTPS endpoint the connection's own `host` names, and a capability grant's
static injection would drop it straight into a spawned process's env — both are exactly the never-echo
violation this connection type exists to prevent. Fixed by excluding `ssh` from `getSecretForUse` the same
way `oauth2` already was; `getSshPrivateKeyForUse` is the dedicated, exec-core-only seam instead. For the
identical reason, `capabilityGrantBindingError` (`profiles/validate.ts`) now also rejects an `ssh`
connection bound to a `requiresConnection` capability grant, alongside its existing `oauth2` rejection.

## ed25519 PEM round-trip (`connections/sshKey.ts`)

`ssh2@1.17.0`'s own `ParsedKey.getPrivatePEM()` can EXPORT an ed25519 key to a PKCS8 PEM
(`-----BEGIN PRIVATE KEY-----`) but cannot RE-IMPORT that same PEM — `ssh2.utils.parseKey` returns
`Error: Unsupported key format` on it (measured directly; RSA/DSA/ECDSA round-trip through their own
traditional PEM headers fine). `ssh2.Client` calls that exact same `parseKey` internally on whatever
string is handed as `privateKey`, so naively storing `getPrivatePEM()`'s output would make every ed25519
connection — the design's recommended key type — unusable the moment the exec core (card f6647205) tries
to connect with it.

Fix: `stripSshKeyPassphrase` detects this (re-parses its own candidate PEM before trusting it) and, for
`type === "ssh-ed25519"` only, hand-builds a minimal UNENCRYPTED `openssh-key-v1` container (PROTOCOL.key
format, ciphername/kdfname "none") from the raw 32-byte seed — extracted from the PKCS8 DER via RFC 8410's
fixed 48-byte layout (the seed is always exactly the last 32 bytes; the function throws if that length
doesn't hold, rather than silently slicing the wrong bytes) — plus the SSH wire-format public-key blob
`ssh2` already parsed correctly.

### Self-verify by sign/verify, not by public-bytes compare (Code Review round 2, card f9972a3d)

`stripSshKeyPassphrase` self-verifies EVERY candidate storable form (the ed25519 rebuild above, and
every other key type's plain `getPrivatePEM()` output) before returning it — never by comparing
`getPublicSSH()` bytes, which proved insufficient: `ssh2`'s own openssh parser reads a key's public and
private wire fields independently, so a container whose PRIVATE field was corrupted or substituted (e.g.
a random 32-byte seed in place of the real one) but whose PUBLIC field is untouched still compares equal
on public bytes alone — measured directly: such a container reparses cleanly and its `getPublicSSH()`
matches the original, yet it is a completely different, unusable key. The self-verify instead signs a
random nonce with the re-parsed CANDIDATE key's actual private material and verifies that signature
against the ORIGINAL parsed key's public half (`original.verify(nonce, candidate.sign(nonce))`) — this
catches a corrupted private field because the resulting signature then fails to verify, which a
public-bytes compare cannot. Refuses to store (never silently falls back) on any sign/verify failure.

## Exec core (child 2, `f6647205`)

`connections/ssh.ts` mirrors this design one level down: one bounded timer covers connect+exec+read; stdout/stderr are each capped mid-stream, never buffered past the cap, and the channel drains to its real exit rather than being killed on cap; a connect/parse failure maps to a fixed, generic error, never ssh2's own error text as-is.

`settleSsh2Client` guards two different failure modes, not one: a permanent no-op `'error'` sink (the CRASH guard — ssh2's own internal `readyTimeout` fires a LATE `'error'` on every pre-handshake timeout, in the same timers pass we may already have settled in, so without a listener that late error is uncaught and crashes the daemon) and a direct `_sock.destroy()` bypassing ssh2's own `isWritable()` guard (the LEAK guard — `end()` alone can leave the real socket open if the peer never closes its side; `destroy()`'s own `'close'` event is asynchronous, so this does not itself prevent the crash the sink already guards against).

`test/ssh-exec-core.mjs`'s section 8 tests the crash guard in isolation from whether the real code forwards `readyTimeout` at all (section 8d pins that separately): it wraps `ssh2.Client.prototype.connect` to FORCE a short, test-controlled internal `readyTimeout` (900ms, deliberately longer than the test's own 500ms external bound) regardless of what the real `connect()` call passes. That decoupling is why the reproduction only needs to wait ~1.5s instead of the ~20.7s a real, unforced `readyTimeout` default would take — removing the sink alone (mutant A: sink and `readyTimeout`-forwarding both removed, i.e. the real pre-fix state) still reddens it, just fast.

## Dev/test exercises the pure-JS cipher path; a real install can exercise the native one (card `fcf2d7e6`, measured 2026-11-04)

Loom's dev root excludes `ssh2` (and its optional `cpu-features`) from `pnpm.onlyBuiltDependencies`, so a
contributor's `pnpm install` never runs either package's `install` script — `ssh2` never builds its own
bundled native crypto addon (`lib/protocol/crypto/build/Release/sshcrypto.node`, compiled by `ssh2`'s own
`install.js` against `lib/protocol/crypto/binding.gyp` — a *different* native addon than `cpu-features`),
so dev/test always exercise `ssh2`'s pure-JS `GenericCipher`/`AESGCMCipher`/`ChaChaPolyCipher`
implementations. A real end-user `npm i -g` install does run that script. Measured directly (isolated
scratch install, no other deps): on a host with a working build toolchain (VS2022 Build Tools + Python),
the addon builds successfully and `ssh2` switches to its native implementation instead — confirmed via a
`require()` probe against the freshly-built install. This is only an **implementation** difference, never
a **protocol** one — both paths speak the same SSH2 wire protocol and the same cipher suite list; the only
other place `cpu-features` (a separate, also install-time-built, package) matters is purely cosmetic: it
detects AES-NI support and only reorders which cipher `ssh2` *offers first* during negotiation, never which
implementation actually runs. The **no-build-tools case is unmeasured** — this host always had a real
toolchain reachable regardless of how the probe tried to hide it, so whether `ssh2`'s pure-JS fallback is
what a toolchain-less end user silently gets (the expected, documented behavior) was not independently
confirmed by a real failure-to-build repro; don't treat it as verified. See `docs/releasing.md`'s
"`ssh2` (+ its optional `cpu-features`) at `npm i -g` time" note for the install-script behavior itself.

## The `ssh_exec` tool (child 3, card `699fdbd9`)

`mcp/server.ts` registers `ssh_exec({connectionId, command})` on the same stateless, per-request session-ROW read as `authenticated_request` (`session.connections`), only when at least one granted id is a usable `ssh` connection (`resolveUsableSshConnections`). It never reads the profile or agent row, so it stays correct however grant resolution evolves (a grant on the agent row alone registers it; a sibling agent on the same profile without it does not; rewriting the row revokes on the next request). Host, port, user, pinned fingerprint and key always come from the connection row (`connections/sshExec.ts`); the caller supplies only an id and a command.

**Policy, in order** (`connections/sshPolicy.ts`, before any byte is sent): length cap (4096) → ASCII-only, no control characters → **shell syntax is refused outright** (`; & | \` $ ( ) < > { } [ ] * ? ! ~ # \ " ' ^`, newline, tab) → regex rules evaluated in ONE worker thread under ONE ~250 ms budget (`connections/sshRegex.ts`; `terminate()` + refuse `allowlist-regex-timeout` on overrun, so an owner `^(a+)+$` cannot pin the event loop) → risky patterns → read-only verb list → allowlist. Risky patterns are matched against the *tokenized words anywhere* in the command after path-basename folding (so `sudo reboot`, `/sbin/reboot` and `FOO=1 reboot` all match `reboot`); `systemctl` is exempt only when `status`/`is-active`/`is-enabled` is the word IMMEDIATELY after it (any option before the subcommand drops the exemption — the next bare word could be an option's value). The read-only verb list is deliberately tiny: `file` is absent (`file -C -m x` writes), `docker` is a bare `docker ps` with value-less flags only (`docker logs`/`inspect` dump env and secrets, and docker access is root-equivalent), `systemctl` is `status|is-active|is-enabled [unit]` with the subcommand at words[1]; a subcommand is never inferred past an option. **Read-only mode limits which verbs run, NOT what the server-side user can read** — the server-side user is the boundary; the owner can widen the list per connection through the allowlist. Until the approval-hold card exists, a risky match is **refused** (`risky-pattern-requires-approval`), never run.

**Why shell syntax is refused regardless of `readOnly` or rule type:** owner regexes are often unanchored at the end (`^ls`), so allowing shell syntax would let `ls; reboot` satisfy the allowlist and dodge the risky refusal. If an owner ever wants shell syntax on a connection, that is an explicit per-connection opt-in flag on a future card, never an inference from rule types. All of this is **defense-in-depth**: the real boundary is the dedicated server-side least-privileged user (+ `restrict` in `authorized_keys`).

**Audit.** Every call writes two `ssh_command_run` rows (durable kind) sharing `detail.callId`: an `attempt` row written *before any step that can throw* (if it cannot be written the call is refused and nothing runs), then an `outcome` row on every caught path (`refused` + reason, `error` + errorKind, or `ran` + exitCode). **An attempt row with no outcome row means the daemon died mid-call OR the outcome write itself failed after the command really ran** (in that second case one command-free `[ssh_exec] outcome audit row not written callId=… connectionId=…` line is logged, so treat an unpaired attempt as "the command may have run"). Command text lives only in these rows, never in a log line; output bodies are never stored (lengths only).

**Failure kinds.** The exec core now distinguishes `auth-refused` (ssh2 error `level` is `client-authentication`) from `unreachable` (`client-socket`/`client-dns`); both are classified from the `level` tag only, never ssh2's message text. Exec-open failure stays `connection-failed`.

**Rate limit:** per connection, in memory, reusing `platform.connections` (`rateLimitMax`/`rateLimitWindowMs`); only calls that pass every policy check and are about to dispatch count.

## Do not

- Do not relax the shell-syntax refusal by inferring safety from `readOnly` or from the rule types — see the `ssh_exec` section above; shell syntax needs an explicit per-connection opt-in on a future card.
- Do not evaluate an owner regex against agent text on the daemon event loop — only through `testRegexesBounded` (one worker, one total budget, fail closed, at most two workers daemon-wide).
- Do not infer a `systemctl`/`docker` subcommand by skipping option words — an option's VALUE is also a bare word (`systemctl -o cat stop sshd`).
- Do not write the `ssh_command_run` attempt row after any step that can throw, and do not let a caught path skip its outcome row.
- Do not register `ssh_exec` from the profile or agent row; key it on the session row's `connections` only.
- Do not put command text, ssh2 error text, output bodies or key material in a log line, a returned error or an audit row beyond the exact command and fixed reason codes.

- Do not place the private key, or any derived credential, in an agent-reachable env var, argv, or file — it is decrypted only inside the daemon process, only for the duration of one `ssh_exec` call. The agent gets a tool call, never a socket, cert, or key.
- Do not hand the agent a raw ssh-agent socket, a short-lived certificate, or a ControlMaster socket for this connection type (v1, decision 2 above) — none of the three let Loom see or gate commands after authentication, and the two Windows `ssh` flavors are mutually socket-incompatible anyway (measured above).
- Do not perform a silent trust-on-first-use host-key pin — the fingerprint must be captured and explicitly human-confirmed at connection-create time; refuse, never silently re-pin, on a later mismatch.
- Do not implement the risky-command confirm gate as a new synchronous/blocking primitive — reuse `question_ask(type:"permission")`, re-validated on redemption against the exact command text, never a cached generic approval.
- Do not register `ssh_exec`'s MCP mount on a Tier-1 or Tier-2 route in `gateway/trust-tier.ts` — it stays Tier 0 (loopback-only) by the existing default-deny, same as every other `/mcp*` mount.
- Do not store the SSH key's original passphrase anywhere (decision 5 above) — it is stripped once at creation, in-memory only.
- Do not default a new SSH connection to read-write (decision 1 above) — it defaults read-only; the owner unticks it per connection.
- Do not build a host-group construct (decision 3 above) — one Connection row is one SSH host.
- Do not let `getSecretForUse` ever return an `ssh` row's secret_blob — it must stay excluded alongside `oauth2`, the same way the module's own `@decision a3d5c7f4` comment marks it.
- Do not let a `requiresConnection` capability grant bind to an `ssh` connection without rejecting it in `capabilityGrantBindingError` — same reasoning as the existing `oauth2` rejection there.
