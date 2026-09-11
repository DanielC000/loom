# 55f1b628 — bootstrap-seed binding load must be session-scoped, not global

## Narrative

`createCompanionGateway` (`packages/daemon/src/companion/factory.ts`) loads a session's durable chat bindings filtered to `cfg.sessionId` rather than reading the whole `companion_bindings` table. Under the multi-companion runtime (each enabled config gets its own `ChatGateway` instance), a global read would also hit a correctness bug: the bootstrap-seed guard seeds the single env/Telegram binding only when "this session has NO bindings yet." A GLOBAL binding count can't distinguish that from "a DIFFERENT companion already has bindings" — so companion B would see companion A's rows on the global table and wrongly skip seeding its own env binding, leaving B unreachable over its configured channel.

Filtering to `cfg.sessionId` fixes both at once: it is also what guarantees a gateway's own routing map can never contain another companion's binding (the security property stated inline at the call site).

## Do not

- Do not read `companion_bindings` unfiltered when deciding whether to bootstrap-seed a session's binding — a global count silently starves every companion after the first.

## Source

Inline comment in `packages/daemon/src/companion/factory.ts` (`createCompanionGateway`'s binding-load block), as of the companion closing sweep (card `9fe08ce5`). Introduced by commit `55f1b628` ("multi-companion runtime — arm ALL enabled companions, not just the oldest"). No wording changed beyond joining wrapped source lines and stripping `//` markers.
