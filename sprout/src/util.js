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
