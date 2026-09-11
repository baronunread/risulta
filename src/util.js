// Shared presentation primitives. No imports; safe to require anywhere.

// String model note: the runtime hands handler strings to us as code
// units, and request bodies arrive Latin-1 decoded (each UTF-8 byte
// becomes one unit 0-255), while compiled literals hold true code units.
// Storage round-trips either form byte-identically, but OUTPUT must be
// ASCII-safe: Latin-1-range strings go out as raw bytes under
// charset=utf-8, which corrupts non-English text. Every encoder below
// therefore decodes units to true code points first (see decodeUnits)
// and emits pure ASCII.

// Decode string units to true Unicode code points. Units that form valid
// UTF-8 sequences decode as bytes; anything else (true Latin-1 literals,
// lone surrogates, truncated sequences) passes through as its own value.
// The ambiguous case (a literal "Ã©" vs mojibake "é") decodes, which is
// the common case for request-derived text.
function decodeUnits(text) {
  const input = String(text);
  const out = [];
  let i = 0;
  while (i < input.length) {
    const a = input.charCodeAt(i);
    if (a < 0x80) {
      out.push(a);
      i++;
    } else if (a >= 0xd800 && a <= 0xdbff && i + 1 < input.length) {
      const b = input.charCodeAt(i + 1);
      if (b >= 0xdc00 && b <= 0xdfff) {
        out.push(0x10000 + ((a - 0xd800) << 10) + (b - 0xdc00));
        i += 2;
      } else {
        out.push(a);
        i++;
      }
    } else if (a >= 0xc2 && a <= 0xdf && i + 1 < input.length) {
      const b = input.charCodeAt(i + 1);
      if (b >= 0x80 && b <= 0xbf) {
        out.push(((a & 0x1f) << 6) | (b & 0x3f));
        i += 2;
      } else {
        out.push(a);
        i++;
      }
    } else if (a >= 0xe0 && a <= 0xef && i + 2 < input.length) {
      const b = input.charCodeAt(i + 1);
      const c = input.charCodeAt(i + 2);
      if (b >= 0x80 && b <= 0xbf && c >= 0x80 && c <= 0xbf) {
        const point = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f);
        if (point >= 0x800 && !(point >= 0xd800 && point <= 0xdfff)) {
          out.push(point);
          i += 3;
        } else if (point >= 0xd800 && point <= 0xdbff && i + 5 < input.length) {
          // CESU-8 surrogate pair: two 3-byte sequences back to back.
          const d = input.charCodeAt(i + 3);
          const e = input.charCodeAt(i + 4);
          const f = input.charCodeAt(i + 5);
          if (d === 0xed && e >= 0xb0 && e <= 0xbf && f >= 0x80 && f <= 0xbf) {
            const lo = ((d & 0x0f) << 12) | ((e & 0x3f) << 6) | (f & 0x3f);
            out.push(0x10000 + ((point - 0xd800) << 10) + (lo - 0xdc00));
            i += 6;
          } else {
            out.push(a);
            i++;
          }
        } else {
          out.push(a);
          i++;
        }
      } else {
        out.push(a);
        i++;
      }
    } else if (a >= 0xf0 && a <= 0xf4 && i + 3 < input.length) {
      const b = input.charCodeAt(i + 1);
      const c = input.charCodeAt(i + 2);
      const d = input.charCodeAt(i + 3);
      if (b >= 0x80 && b <= 0xbf && c >= 0x80 && c <= 0xbf && d >= 0x80 && d <= 0xbf) {
        const point = ((a & 0x07) << 18) | ((b & 0x3f) << 12) | ((c & 0x3f) << 6) | (d & 0x3f);
        if (point >= 0x10000 && point <= 0x10ffff) {
          out.push(point);
          i += 4;
        } else {
          out.push(a);
          i++;
        }
      } else {
        out.push(a);
        i++;
      }
    } else {
      out.push(a);
      i++;
    }
  }
  return out;
}

function hex4(n) {
  return ("000" + n.toString(16)).slice(-4);
}

export function escapeHtml(value) {
  const points = decodeUnits(value);
  let out = "";
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === 38) out += "&amp;";
    else if (point === 60) out += "&lt;";
    else if (point === 62) out += "&gt;";
    else if (point === 34) out += "&quot;";
    else if (point < 128) out += String.fromCharCode(point);
    else out += "&#" + point + ";";
  }
  return out;
}
// NOTE: browsers decode the entities back to the same visible text, so
// pages stay correct UTF-8 no matter which unit form the runtime used.

export function fmtInt(n) {
  const neg = Number(n) < 0;
  let s = String(Math.floor(Math.abs(Number(n)) || 0));
  let out = "";
  while (s.length > 3) {
    out = "," + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return (neg ? "-" : "") + s + out;
}

// ASCII-only JSON serializer. Mirrors JSON.stringify for the shapes this
// app emits (null, boolean, finite number, string, array, plain object)
// but escapes every code point at or above 128 as \uXXXX, so API
// responses stay valid ASCII regardless of unit form.
function asciiJsonString(text) {
  const points = decodeUnits(text);
  let out = '"';
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point === 34) out += '\\"';
    else if (point === 92) out += "\\\\";
    else if (point === 10) out += "\\n";
    else if (point === 13) out += "\\r";
    else if (point === 9) out += "\\t";
    else if (point === 8) out += "\\b";
    else if (point === 12) out += "\\f";
    else if (point < 32) out += "\\u" + hex4(point);
    else if (point < 128) out += String.fromCharCode(point);
    else if (point <= 0xffff) out += "\\u" + hex4(point);
    else {
      const base = point - 0x10000;
      out += "\\u" + hex4(0xd800 + Math.floor(base / 1024));
      out += "\\u" + hex4(0xdc00 + (base % 1024));
    }
  }
  return out + '"';
}

export function asciiJson(value) {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  // Strings are the only values strictly equal to their String() form;
  // this avoids typeof, which the lint rules forbid.
  if (value === String(value)) return asciiJsonString(value);
  if (Array.isArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i++) {
      if (i) out += ",";
      out += asciiJson(value[i]);
    }
    return out + "]";
  }
  if (String(value) === "[object Object]") {
    let out = "{";
    let first = true;
    for (const name in value) {
      if (value[name] === undefined) continue;
      if (!first) out += ",";
      first = false;
      out += asciiJsonString(name) + ":" + asciiJson(value[name]);
    }
    return out + "}";
  }
  return String(value);
}

// True UTF-8 bytes of a string as a number array, whatever unit form the
// runtime used. Pass new Uint8Array(of it) to hashing primitives when the
// hash must match an external system over the same text (Bun parity).
export function utf8Bytes(text) {
  const points = decodeUnits(text);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point < 0x80) {
      out.push(point);
    } else if (point < 0x800) {
      out.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      out.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      out.push(
        0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f),
      );
    }
  }
  return out;
}

// Manual UTF-8 encoder returning a string of Latin-1 characters (one per
// output byte), so the transport emits correct UTF-8 bytes. Used for the
// CSV download, where \uXXXX escaping would be wrong.
export function utf8Encode(text) {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// UTC day label (YYYY-MM-DD) from epoch milliseconds using pure integer
// arithmetic (Howard Hinnant's civil_from_days). Deliberately avoids
// `new Date().toISOString()`, which livelocks the standalone runtime when
// called inside async handler turns (upstream issue). All divisions below
// operate on non-negative inputs, so truncation equals flooring.
export function dayStringFromMs(ms) {
  const days = Math.floor(Number(ms) / 86400000);
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = m <= 2 ? y + 1 : y;
  const month = m < 10 ? "0" + m : "" + m;
  const day = d < 10 ? "0" + d : "" + d;
  return year + "-" + month + "-" + day;
}
