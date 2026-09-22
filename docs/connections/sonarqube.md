# SonarQube connection

Card `1e8e9b1e`. Lets an owner give an agent read-only access to a SonarQube project's code-quality
signal — quality gate status, issues, coverage — without the agent ever seeing the credential.

## Set it up

1. **Settings → Connections → New connection → SonarQube.**
2. **Host**: a bare hostname, no `https://` — `sonarcloud.io` for SonarCloud, or your self-hosted
   instance's host (e.g. `sonarqube.mycompany.com`). A pasted full URL is normalized automatically.
3. **User token**: SonarQube/SonarCloud → My Account → Security → Generate Token. A token scoped to
   **Browse** access on the project(s) you want visible is enough — no admin/Execute Analysis scope is
   needed for the read surface below.
4. Loom validates the host+token live (against `/api/users/current`) before saving — a wrong token or
   host is refused with a clear error, never silently stored.
5. **Grant it to a profile**: Settings → Actors → the profile → Connections → tick the new connection,
   Save. This is the same human-only step every connection needs — Loom never auto-grants one.

## What an agent can actually do once granted

A session whose profile grants this connection gets the `authenticated_request` MCP tool with this
connection's id. It is a generic credential-injected HTTP passthrough (Loom builds the URL from the
connection's fixed host + the agent's path and injects `Authorization: Bearer <token>` server-side — the
token itself never reaches the agent or a transcript). Useful read-only SonarQube Web API paths:

- `GET /api/qualitygates/project_status?projectKey=<key>` — pass/fail quality gate status.
- `GET /api/issues/search?componentKeys=<key>&resolved=false` — open issues (bugs/vulnerabilities/code
  smells).
- `GET /api/measures/component?component=<key>&metricKeys=coverage,duplicated_lines_density,ncloc` —
  coverage/duplication/size metrics.
- `GET /api/project_branches/list?project=<key>` — branch discovery, useful before any of the above on a
  multi-branch project.

Example tool call (from an allowlisted session):

```
authenticated_request({
  connection: "<the connection id>",
  path: "/api/qualitygates/project_status?projectKey=my-project"
})
```

## Architecture note — why this is a connection, not a dedicated "capability"

Loom also has a generic capability-catalog mechanism (`capabilities/registry.ts`) for mounting a
dedicated per-session MCP server bound to a connection — that's how GitHub and image-gen work. A
SonarQube-specific MCP server was investigated for this card and deliberately NOT built for v1:

- The **official** SonarSource MCP server (`github.com/SonarSource/sonarqube-mcp-server`) ships as a JVM
  application only (Docker image or a standalone JAR needing Java 21+) — there is no npm package. Loom's
  capability provisioning kinds (`node-package` / `python-venv` / `bundled` / `command` / `github-binary`)
  have no JVM-management story, and building one is a materially bigger change than this card scopes.
- The most-installed **third-party** npm alternative (`sonarqube-mcp-server`, npm) is explicitly marked
  no-longer-maintained by its own author, who redirects users to the official (JVM-only) server above —
  not something to bind a live credential to.

The existing `authenticated_request` tool + this connection already deliver the owner's approved v1 scope
(read-only insight) with zero new provisioning machinery. If a genuinely richer SonarQube tool surface
becomes worth the JVM-provisioning investment later, that is a fresh, separate card — see
`docs/decisions/1e8e9b1e-sonarqube-validate-endpoint-and-auth-scheme.md` for the validation-endpoint and
auth-scheme choices made along the way.

## Scope

This connection only covers **read-only insight** (quality gate status, issues, coverage) — the owner
explicitly deferred SonarQube-gated merge-gate enforcement as a possible future card, not built here.
