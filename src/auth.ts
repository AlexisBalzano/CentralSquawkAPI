/**
 * Controller authentication.
 *
 * The token is SHA256(shared secret + controller callsign), matching the
 * plugin. This is a KNOWN WEAK scheme and an accepted risk recorded in the
 * design: the secret is compiled into the distributed DLL, so any user can
 * extract it and forge a token for any controller callsign. It exists to stop
 * casual misuse, not a determined one.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function expectedToken(secret: string, callsign: string): string {
  return createHash("sha256").update(secret + callsign).digest("hex");
}

export function verifyToken(
  secret: string,
  callsign: string,
  presented: string | undefined,
): boolean {
  if (!secret) return true; // unset secret disables verification, for local dev
  if (!presented) return false;
  const expected = Buffer.from(expectedToken(secret, callsign), "utf8");
  const actual = Buffer.from(presented.trim().toLowerCase(), "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** GitHub webhook signature: `sha256=<hex hmac of the raw body>`. */
export function verifyGithubSignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (!secret) return true; // unset secret disables verification
  if (!header) return false;
  const expected = Buffer.from(
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    "utf8",
  );
  const actual = Buffer.from(header, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
