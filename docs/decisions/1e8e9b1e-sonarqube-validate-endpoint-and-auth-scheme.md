# 1e8e9b1e — SonarQube connection preset: validate via `/api/users/current`, auth via `bearer`

## Context

Card `1e8e9b1e` (SonarQube connection + capability) needs a "cheap read endpoint" to validate a
host+token pair before `createConnection` ever persists it (DoD-1), and needs to pick which of Loom's
existing `ConnectionAuthScheme`s (`api-key` / `bearer` / `oauth2`) a SonarQube User Token maps to.

## Decision

**Validation endpoint: `GET /api/users/current`, not `/api/authentication/validate`.**
SonarQube's own `/api/authentication/validate` looks like the obvious choice, but it is NOT reliable for
this purpose: it returns `{"valid":true}` for an ANONYMOUS request whenever the target instance allows
anonymous browsing, so a wrong/expired/missing token would silently "validate" on any such instance. This
is a reported, known behavior — see the SonarSource Community thread "Web API Validate Endpoint Returns
True For Every Value" (community.sonarsource.com). `/api/users/current` — the standard "who am I"
endpoint most SonarQube-integrating tools use to test credentials — genuinely requires an authenticated
identity: an invalid/missing token gets a 401, never a silent pass-through.

**Auth scheme: `bearer`.** Verified against the official SonarSource MCP server's own documentation
(github.com/SonarSource/sonarqube-mcp-server): a SonarQube User Token is accepted via
`Authorization: Bearer <token>` on both self-hosted SonarQube Server and SonarCloud. This matches Loom's
existing `bearer` connection scheme (`connections/request.ts` already sends
`Authorization: Bearer <secret>` for it) — no new auth-header plumbing was needed.

## Do not

- Do not switch the pre-save validation probe to `/api/authentication/validate` — it can return a false
  positive on any SonarQube instance with anonymous access enabled, defeating the whole point of DoD-1's
  "validate before saving."
- Do not add `api-key` as a second selectable scheme for the SonarQube preset without re-verifying against
  a real target version first — the evidence above is specific to the modern Bearer-token path.
