// Dev-only correctness check for dayStringFromMs against the platform
// Date (run with bun; never bundled into the sprout).
import { dayStringFromMs } from "../src/util.js";

const cases = [
  0, // epoch
  86400000 - 1,
  86400000,
  Date.parse("2000-02-29T12:00:00Z"), // leap century
  Date.parse("2024-02-29T00:00:00Z"), // leap day start
  Date.parse("2024-02-29T23:59:59Z"), // leap day end
  Date.parse("2024-03-01T00:00:00Z"),
  Date.parse("2100-02-28T00:00:00Z"), // non-leap century
  Date.parse("2100-03-01T00:00:00Z"),
  Date.parse("2026-09-11T00:00:00Z"),
  Date.now(),
];
let seed = 123456789;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed;
};
for (let i = 0; i < 2000; i++) cases.push(Math.floor((rand() / 2147483648) * 4102444800000));
let failures = 0;
for (const ms of cases) {
  const want = new Date(ms).toISOString().slice(0, 10);
  const got = dayStringFromMs(ms);
  if (got !== want) {
    failures += 1;
    console.error(`FAIL ms=${ms}: got ${got}, want ${want}`);
    if (failures > 5) process.exit(1);
  }
}
if (failures) process.exit(1);
console.log(`dayString OK (${cases.length} cases)`);
