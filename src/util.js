// Shared presentation primitives. No imports; safe to require anywhere.

export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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
