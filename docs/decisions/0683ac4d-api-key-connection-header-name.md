# 0683ac4d — an api-key connection may name the header that carries its secret

The first consumer is the owner's Plex (`X-Plex-Token`), reached over plain HTTP on a LAN host (card `1d882a8c`). `request.ts` hard-coded `X-API-Key` for the `api-key` scheme, so Plex still could not authenticate. A per-connection `apiKeyHeader` (column `api_key_header`, NULL = `X-API-Key`) fixes that without a second auth scheme.

## Do not

- Do not add an MCP tool, an MCP input field, a remote-tier route or any agent-writable path that sets `apiKeyHeader`. It is set only over the loopback REST create/PATCH (Tier 0) and the Settings forms.
- Do not accept a framing, connection-management, proxy or credential header name: Host, Content-Length, Transfer-Encoding, Connection, Upgrade, TE, Trailer, Keep-Alive, `Proxy-*`, Cookie, Authorization (case-insensitive). Authorization belongs to bearer; the rest let a configured name corrupt request framing or smuggle a second credential.
- Do not honour or store the field for any scheme but api-key. A swap away from api-key clears it; an oauth2/ssh row never surfaces it.
- Do not let a caller header that differs from the credential header only by case travel beside it; Loom's credential header wins outright.
- Do not echo the header value anywhere. The audit event names the FIELD (`apiKeyHeader`) only, and the secret stays redacted from every result, error, `location` and log.
- Do not add a base-SCHEMA index on `api_key_header`; it is added to existing databases by `CONNECTION_ADDED_COLUMNS`.

The pinned plain-HTTP adapter (`lanHttp.ts`) drops only hop-by-hop request headers, none of which this validator permits, so the configured header survives both the https and the pinned http paths (pinned by `test/connections-api-key-header.mjs`, group D, against a real loopback server).
