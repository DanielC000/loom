# 7b812c18 — ssh host-key re-pin: human-only, exact, compare-and-swap

An `ssh_exec` host-key mismatch used to return only `kind: "host-key-mismatch"`. It now also returns `presentedFingerprint` (the SHA256 the host actually presented — public data) in the tool result and the outcome audit row, so the owner can see what changed. The owner re-pins from the connection's edit form: "Fetch from host" probes the live key, and when it differs from the pin at the unchanged address the form offers "Re-pin to this fingerprint", which calls `POST /api/connections/:id/ssh/repin-host-key` with `{fingerprint, previousFingerprint}`.

The route (Tier 0 loopback, no MCP tool on any router) refuses unless `previousFingerprint` is still the current pin (409), the host presents `fingerprint` right now (409; 502 if it can't be read), and the fingerprint is well-formed (400). A re-pin files one `ssh_host_key_repinned` event (`connectionId`, `previousFingerprint`, `fingerprint`; in `DURABLE_AUDIT_EVENT_KINDS` like `ssh_command_run`, audit-only, none of the four lifecycle groupings). It is the explicit, audited human action `a3d5c7f4` allows; it is not trust-on-first-use.

## Two re-pin paths, both audited

The live re-pin route files `ssh_host_key_repinned` with `via: "live-repin"`. The route also verifies the address: it captures `host` and `sshPort` before the live probe and `repinSshHostKey` re-checks both inside the write transaction (409 on any change), so an address edit landing mid-probe cannot pin a key verified only at the old address.

The owner's manual path, `PUT /api/connections/:id/ssh` with a changed `hostKeyFingerprint` at an UNCHANGED address, stays (it is the owner's manual pin/edit path) and ALSO files `ssh_host_key_repinned`, with `via: "manual-edit"`. That path deliberately has no live re-check: the owner may be pasting a fingerprint obtained out of band (a console, `ssh-keygen -l`) from a host that is not reachable from the daemon right now, and the owner is the trust authority, so the edit's own audit row is the control. A host/port change (new pin for a new address) is not a re-pin and files only `connection_updated`.

## Do not

- Do not add an MCP tool, or any agent-callable path, that re-pins or accepts a host key; reporting `presentedFingerprint` to the agent pins nothing.
- Do not add an "accept the next key" / "trust whatever is presented" option: a re-pin writes exactly the fingerprint in the request and only while `previousFingerprint` is still the current pin.
- Do not skip the live re-check that the host presents the requested fingerprint, and do not pin on a 502 (unreadable host).
- Do not put a value other than the two public fingerprints, the connection id and the `via` label in the event detail.
- Do not drop the in-transaction address check in `repinSshHostKey`, and do not file a manual-edit re-pin event when the address changed.
- Do not normalize a scheme out of `host` (owner decision `bf39ab98`: host is `host[:port]`, HTTPS by default, "Allow plain HTTP" for http); the refusal text names that rule.
