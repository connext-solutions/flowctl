/** A dotted-quad IPv4 literal, every part 0 to 255. */
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * True for a loopback or RFC 1918 host, the only hosts plain `http` may reach (ADR 0024 section 3, rule 1): `localhost`,
 * `[::1]`, or an IPv4 literal in 127/8, 10/8, 172.16/12 or 192.168/16. A name such as `10.evil.com` is not an address.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h === '[::1]') return true;
  if (!IPV4.test(h)) return false;
  const [a = 0, b = 0] = h.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}
