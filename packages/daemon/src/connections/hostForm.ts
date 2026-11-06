/**
 * The ONE canonical-host round-trip, shared by `validateConnectionHost` (store.ts, create/edit/flag) and
 * `buildRequestUrl` (request.ts, every outbound call) so a host the validator accepts can never be one the
 * request builder refuses. A host is usable only if parsing `<scheme>://<host>` yields exactly that host
 * (lowercased): `URL` rewrites an IDN to punycode, an uncompressed IPv6 to its compressed form, IPv4
 * shorthand (`0x7f.1`) to dotted decimal and decodes percent-escapes, drops a scheme's DEFAULT port (`:443`
 * for https, `:80` for http), and throws on e.g. `[1.2.3.4]` — every one of those means the stored text is
 * not the host that would be dialled.
 *
 * The scheme is a parameter, never parsed out of the host: it comes from the connection's own field
 * (`allowPlainHttp`), so the single rule serves both forms without a second copy to drift.
 */
export type ConnectionUrlScheme = "https" | "http";

export function hostRoundTrips(host: string, scheme: ConnectionUrlScheme): boolean {
  try {
    return new URL(`${scheme}://${host}`).host === host.toLowerCase();
  } catch {
    return false;
  }
}

export function httpsHostRoundTrips(host: string): boolean {
  return hostRoundTrips(host, "https");
}
