# 230cb6e3 — a failed links read says so, rather than rendering as a false zero

A LIVE card renders the card-drawer's context section (parent/children/relations, card `1ae4f88c`) off
its board row. If that read fails, `links` comes back empty — which is byte-identical to a card that
genuinely has no connections. Rendering nothing in that case would silently misreport a real failure as
"no links."

## Do not

- Do not let a failed links read render the same as an empty result. Show a "links unavailable" state
  instead; the underlying poll keeps retrying, so the line clears itself once the read recovers.
