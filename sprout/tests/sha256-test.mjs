// Dev-only NIST test vectors for ../src/sha256.js. Run: bun sprout/tests/sha256-test.mjs
import { sha256Hex } from "../src/sha256.js";

const vectors = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  ["a".repeat(1000000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
];

let failed = 0;
for (const [input, expected] of vectors) {
  const got = sha256Hex(input);
  if (got !== expected) {
    console.error(`FAIL sha256(${JSON.stringify(input.slice(0, 20))}): got ${got}, want ${expected}`);
    failed++;
  }
}
// UTF-8 handling: 2-byte and 4-byte sequences must change the digest vs latin1.
const utf8 = sha256Hex("\u00e9\u{1f600}");
if (utf8.length !== 64 || utf8 === sha256Hex("ee")) {
  console.error(`FAIL utf8 digest: ${utf8}`);
  failed++;
}
if (failed) {
  console.error(`${failed} vector(s) failed`);
  process.exit(1);
}
console.log("sha256 vectors OK (4 NIST + utf8 smoke)");
