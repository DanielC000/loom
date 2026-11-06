/**
 * The ONE canonical-host round-trip, shared by `validateConnectionHost` (store.ts, create/edit/flag) and
 * `buildRequestUrl` (request.ts, every outbound call) so a host the validator accepts can never be one the
 * request builder refuses. A https host is usable only if parsing `https://<host>` yields exactly that host
 * (lowercased): `URL` rewrites an IDN to punycode, an uncompressed IPv6 to its compressed form, IPv4
 * shorthand (`0x7f.1`) to dotted decimal and decodes percent-escapes, and throws on e.g. `[1.2.3.4]` —
 * every one of those means the stored text is not the host that would be dialled.
 */
export function httpsHostRoundTrips(host: string): boolean {
  try {
    return new URL(`https://${host}`).host === host.toLowerCase();
  } catch {
    return false;
  }
}
