/**
 * Turn why a device's LAN / tailnet path failed into what the user can do.
 *
 * The server reports raw socket errors per address ("192.168.1.8:7681 connect
 * EHOSTUNREACH …"). Each failure shape has a few usual causes, and when
 * several addresses fail the most telling one wins: being blocked outright
 * says more than a timeout, which says more than a refusal.
 */
export type DirectPathHint = "blocked" | "timeout" | "refused";

export function directPathHint(note: string | null | undefined): DirectPathHint | null {
  if (!note) return null;
  // macOS 15+ answers a connect to a LAN address with "no route to host" when
  // the app lacks the Local Network permission; isolated Wi-Fi does the same.
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|no route to host|EPERM|EACCES/i.test(note)) return "blocked";
  if (/timed out|ETIMEDOUT|no reply in time/i.test(note)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET/i.test(note)) return "refused";
  return null;
}
