// Dev-only checks for the ASCII-safe output encoders (run with bun;
// never bundled into the sprout). The runtime emits Latin-1-range
// strings as raw bytes, so HTML escapes to entities, JSON to \uXXXX,
// and CSV through manual UTF-8 encoding.
import { asciiJson, escapeHtml, utf8Bytes, utf8Encode } from "../src/util.js";
import assert from "node:assert/strict";

// escapeHtml: markup chars plus every code point >= 128 as entities.
assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
assert.equal(escapeHtml("Café · → ✓"), "Caf&#233; &#183; &#8594; &#10003;");
assert.equal(escapeHtml("😀"), "&#128512;");
assert.equal(escapeHtml("a\ud800b"), "a&#55296;b");
// Runtime unit form: request text arrives Latin-1 decoded (each UTF-8 byte
// one unit). It must render identically to the true-unit form above.
assert.equal(escapeHtml("Caf\xc3\xa9 \xe2\x86\x92"), "Caf&#233; &#8594;");
assert.equal(escapeHtml("\xed\xa0\xbd\xed\xb8\x80"), "&#128512;");

// asciiJson: deep-equal to JSON.parse(JSON.stringify(x)) after parsing,
// and pure ASCII on the wire.
const samples = [
  null, true, false, 0, 42, -3, 1.5,
  "", "plain", "Café → ✓ 😀", 'quote " backslash \\ newline\n tab\t',
  [], [1, "x", null, true],
  {},
  { a: 1, b: "Café", c: [1, { d: "→" }], e: null },
  { label: "/café", pageviews: 3, visitors: 2, value: 0 },
];
function isAscii(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}

for (const sample of samples) {
  const got = asciiJson(sample);
  assert.deepEqual(JSON.parse(got), JSON.parse(JSON.stringify(sample)));
  assert.ok(isAscii(got), `non-ASCII in output: ${got}`);
}
const unicodeStrings = ["Café", "→ ✓", "😀", "/café"];
for (const text of unicodeStrings) {
  assert.ok(asciiJson(text).includes("\\u"), `expected escapes for ${text}`);
}
// Latin-1-unit form (runtime request text) encodes identically.
assert.equal(asciiJson("Caf\xc3\xa9"), asciiJson("Café"));
// undefined handling mirrors JSON.stringify (null in arrays, dropped keys).
assert.equal(asciiJson([undefined]), "[null]");
assert.equal(asciiJson({ a: undefined, b: 1 }), '{"b":1}');

// utf8Encode: byte-identical to real UTF-8 for true-unit strings...
const texts = ["", "plain", "Café → ✓", "日本語", "😀🎉"];
for (const text of texts) {
  const got = utf8Encode(text);
  const want = Buffer.from(text, "utf8").toString("latin1");
  assert.equal(got, want, `utf8Encode mismatch for ${JSON.stringify(text)}`);
}
// ...and Latin-1-unit form (runtime request text) encodes to the same
// bytes as the true-unit form.
assert.equal(utf8Encode("Caf\xc3\xa9"), utf8Encode("Café"));
assert.equal(utf8Encode("\xe2\x86\x92"), utf8Encode("→"));
// utf8Bytes feeds hashing primitives with exact input bytes.
assert.deepEqual(utf8Bytes("ABC"), [65, 66, 67]);
assert.deepEqual(utf8Bytes("Caf\xc3\xa9"), [67, 97, 102, 195, 169]);
assert.deepEqual(utf8Bytes("Café"), [67, 97, 102, 195, 169]);

console.log("encoding OK (escapeHtml, asciiJson, utf8Encode)");
