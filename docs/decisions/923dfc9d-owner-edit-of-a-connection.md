# 923dfc9d — the owner can edit a stored connection (human REST + Settings only)

A connection used to be create-or-delete: changing a host or rotating a key meant revoking it, which dropped the id every agent grant and capability binding stores. An edit now keeps the row (and so its id, `createdAt` and every grant that names it) and re-validates what depends on the changed field.

## Surface

- `PATCH /api/connections/:id` — api-key / bearer / oauth2. Editable: `name`, `host` (all three), `authScheme` (api-key <-> bearer only) and `secret` (api-key / bearer only).
- `PUT /api/connections/:id/ssh` — ssh. Editable: `name`, `host`, `port`, `user`, `privateKey` (+ `passphrase`), `hostKeyFingerprint`, and the existing `readOnly` / `commandAllowlist` / `riskyCommandPatterns`.
- Both are loopback REST behind the owner; there is NO agent MCP tool and no router tool-list change. The code is `connections/store.ts` (`updateConnection`, `updateSshConnection`, `ConnectionInputError`), one UPDATE in `Db.updateConnection`, and Settings → Connections (`ConnectionEditForm`, `SshConnectionRowDetail`).

## Rules

- **The secret is write-only.** An absent or blank `secret` / `privateKey` means unchanged (the ciphertext is byte-identical afterwards); a value rotates it. The response is `ConnectionMetadata`, the form never pre-fills the field, and the mutation uses `gcTime: 0` so a pasted value does not linger in the client cache.
- **Immutable:** `projectId` (re-scoping could orphan grants held by other projects' agents), and for oauth2 everything but name/host (changing client id / secret / URLs / scopes invalidates the stored token bundle — delete and re-create). `authScheme` may only swap api-key <-> bearer: the capability-binding check accepts exactly those two, so no swap can make a stored binding invalid. A refused field answers 400 naming it.
- **Name:** a rename must not collide with any other row (409), because `provisionConnection` / `getConnectionByName` resolve by exact name (card 193de09e). Renaming to its own name is not a collision.
- **Host change, api-key / bearer / oauth2:** every profile whose `codexProvider.connectionId` is this connection, AND every resumable session (not archived, not proven dead) whose own pinned `codexProvider` names it, must still satisfy `codexProviderBindingError` with the new host, else the edit is refused (409) naming the profile(s) and session(s). A session counts because a resume re-reads its row, never the profile. The check is the SAME function the profile-save routes and `PtyHost` use — `PtyHost` re-checks at every codex spawn and refuses on a mismatch, so allowing the edit would silently brick those profiles' spawns.
- **Host or port change, ssh:** a new `hostKeyFingerprint` is REQUIRED in the same request (400 otherwise). The pin is the host key of the machine at that address, so keeping the old one would trust one machine's key for another address. There is no "clear the pin": `ssh_exec` refuses an unpinned connection. A `user`-only or key-only change does NOT need a re-pin, because the host key is unchanged. A re-pin is explicit input (the UI offers the existing fetch-and-confirm), never a silent trust-on-first-use.
- **Approvals:** `sshApprovalAction` hashes id + user@host:port + the pin, so editing any of those makes every pending / standing / deny hold for the old target stop matching by construction. `connections-edit.mjs` pins this.
- **Audit:** every edit that changes something appends a `connection_updated` orchestration event with `{connectionId, fields, secretRotated}` — field NAMES only, never a value, never the secret. A no-op edit appends nothing. The UPDATE and the event commit in ONE `runInTransaction`, so a saved credential change always has its audit row, and an event failure saves nothing.

## When a change takes effect

A change is read at the next USE, not retroactively inside something already built:
- `authenticated_request` and `ssh_exec` re-read the connection row on every tool call, so a live session sees the new host / secret on its next call. This is how secret rotation already behaved (`provisionConnection` scoped rotation), and the owner accepted it over a per-session snapshot.
- A codex provider and a capability's env var are resolved at spawn, so they pick the change up at the next spawn.

## Do not

- Do not add an MCP tool, or any agent-callable path, that edits a connection (the surface-drift and credential-surface tests pin the router tool lists; a new tool would be a trust-boundary change needing its own decision).
- Do not echo a secret, key or passphrase value in a response, an audit event, or any log line; and do not put a value in `connection_updated.detail` (names and `secretRotated` only).
- Do not accept a host or port change without an EXPLICIT `hostKeyFingerprint` in the same request (it may equal the old pin when the owner re-confirms the same machine on a new address or port); the old pin is never implicitly carried over. Do not add a "clear the pin" option or a silent trust-on-first-use re-pin.
- Do not make `projectId` or an oauth2 row's client / URL / scope fields editable without re-deciding the grant-orphaning and token-bundle consequences above.
- Do not re-implement the codexProvider host rule in the edit path; call `codexProviderBindingError` so the REST rule, the profile-save rule and the spawn-time rule cannot drift.
- Do not allow an `authScheme` swap to or from oauth2 / ssh: their `secret_blob` shapes differ (a token bundle / a PEM) and a swap would corrupt it.
