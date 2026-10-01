# 4bd4e4a6 — the vault editor seeds only from content PROVEN to be the selected note's

## Narrative

Card 4bd4e4a6. The Vault page's file-content query (`packages/web/src/pages/Vault.tsx`) uses react-query's `placeholderData: keepPreviousData`, which is the right call for the VIEWER: clicking through a tree of notes would otherwise blank the pane on every selection. It means, though, that while a newly selected note is still fetching, `content.data` still describes the PREVIOUSLY selected path — react-query flags that with `isPlaceholderData`, and the daemon's own response echoes the `path` it answered for, so there are two ways to know.

Nothing read either one. `Edit` was gated on `content.data?.content === undefined`, which is satisfied by placeholder data, so Edit stayed live through the whole switch window. `VaultEditor` is `key={file}` with `const [text, setText] = useState(content)` — a `useState` initializer samples its argument ONCE, at mount, and never again. So an editor opened inside that window mounted keyed to the NEW path while capturing the OLD note's body. When the new note's content then landed, the `content` prop changed under the already-mounted editor, `dirty` (`text !== content`) went true, Save enabled, and `save.mutate({ path: file, content: text })` wrote the previous note's entire body over the newly selected file. The note it replaced was gone — a vault write commits through the daemon's shared vault-commit path, so git holds the prior revision, but nothing in the UI says a thing happened.

This was reproduced before it was fixed, end to end, in `packages/web/e2e/vault.spec.ts` against an isolated daemon: two notes with disjoint bodies, the second note's content fetch held open with `page.route`, Edit clicked in the window, Save clicked once the real content arrived. `Bravo.md` on disk afterwards read `# Alpha` plus Alpha's body — Bravo's own body absent. The window is a few milliseconds on localhost, which is why holding the one request (rather than a timing assumption) is what makes it observable; the spec asserts the ON-DISK file, because that is the only place the loss is visible at all.

The fix introduces one derived value, `loaded`, as the single body any consumer may read, and makes it fail CLOSED on two independent checks — `!content.isPlaceholderData` AND `content.data.path === file`. The second is redundant today and deliberately kept: it is the daemon's own statement of which file it answered for, so it survives someone later changing the query's options (dropping `keepPreviousData`, adding `initialData`) in a way that would quietly defeat the flag alone. If the echoed path ever stopped matching, Edit would be permanently disabled — visibly broken in the safe direction, and covered by an e2e that asserts Edit re-arms once content lands.

The same card closed the adjacent blindness. The query had no `isError` branch, and react-query only applies `placeholderData` while `status === "pending"` (`queryObserver.ts`), so a 404 left `data` undefined with `isError` true, and the viewer's `content === undefined` fallthrough rendered `…` forever. A note an agent renamed out from under an open viewer therefore looked like a load that never finished. `ReadError` now renders the daemon's own reason plus a Retry, and `api.vaultFile` moved from `get` to `getErr` so that reason (`file not found`) reaches the UI instead of an opaque `… -> 404`. The query also sets `retry: false`: a vault read is a local file read, so a failure is a real answer rather than a blip worth three backed-off retries before the reader is told anything.

## Do not

- Do not let any write path read `content.data` directly instead of `loaded` — an editor seeded from placeholder data overwrites the newly selected note with the previously viewed one's body.
- Do not "simplify" `loaded` by dropping the `content.data.path === file` check as redundant. It is the daemon-asserted half of the identity proof and is what keeps the gate closed if the query's options change later.
- Do not assume `placeholderData` masks an error. It applies only while `status === "pending"`, so an errored query falls through to `data === undefined` — which is exactly how the endless `…` happened.
- Do not gate an editor's readiness on "is there any content" when a query can serve another key's content. Gate it on "is this content THIS key's".

## Source

`packages/web/src/pages/Vault.tsx` (the `loaded` derivation above the Edit button, and `ReadError`); `packages/web/src/lib/api.ts` (`vaultFile`); reproduced + regression-covered by the three card-4bd4e4a6 tests in `packages/web/e2e/vault.spec.ts`.
