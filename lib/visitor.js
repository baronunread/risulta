import { createHash } from "node:crypto";

// A site-local salt changes every UTC day, so identities cannot be linked across days.
export function dailyVisitorId(salt, ip, userAgent) {
  return createHash("sha256").update(salt).update(ip).update(userAgent).digest("hex").slice(0, 24);
}
