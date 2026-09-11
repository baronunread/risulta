// Dev-only helper for verify.sh: prints one Bun-format scrypt password row
// (scrypt$N$r$p$salt$hash, base64url) for the password in SCRYPT_PW, using
// node:crypto directly. Run: SCRYPT_PW=... bun tests/make-scrypt-fixture.mjs
import { randomBytes, scryptSync } from "node:crypto";

const password = process.env.SCRYPT_PW || "";
if (!password) {
  console.error("Set SCRYPT_PW first.");
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 128 * 1024 * 1024 });
console.log(`scrypt$32768$8$3$${salt.toString("base64url")}$${hash.toString("base64url")}`);
