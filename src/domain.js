// Event domain rules: validation, attribution, ranges. No imports;
// pure functions over strings and search params.

export function cleanDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .slice(0, 253);
}

export function validDomain(value) {
  if (value === "localhost") return true;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function validEventName(name) {
  return /^[a-z][a-z0-9_]{0,63}$/.test(String(name || ""));
}

export function validValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000) return false;
  return n;
}

// Split "path + query" into a bounded pathname and bounded UTM attribution.
// Non-attribution query parameters are dropped, never stored.
export function splitPathAndAttribution(rawPath) {
  const raw = String(rawPath || "").slice(0, 2048);
  const q = raw.indexOf("?");
  const pathname = (q === -1 ? raw : raw.slice(0, q)).slice(0, 2048) || "/";
  const out = { path: pathname, source: "", medium: "", campaign: "", content: "", term: "" };
  if (q === -1) return out;
  const params = new URLSearchParams(raw.slice(q + 1));
  out.source = String(params.get("utm_source") || "").trim().slice(0, 128);
  out.medium = String(params.get("utm_medium") || "").trim().slice(0, 128);
  out.campaign = String(params.get("utm_campaign") || "").trim().slice(0, 128);
  out.content = String(params.get("utm_content") || "").trim().slice(0, 128);
  out.term = String(params.get("utm_term") || "").trim().slice(0, 128);
  return out;
}

export function referrerHost(value) {
  const raw = String(value || "").trim().slice(0, 2048);
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase().slice(0, 253);
  } catch {
    return "";
  }
}

// Range selection: explicit UTC from/to (YYYY-MM-DD, at most 366 days) or a
// period in days. until is one second past now so events in the current
// second stay visible. Uses Date.UTC with explicit components only.
export function parseRange(searchParams, now) {
  const fromRaw = searchParams.get("from") || "";
  const toRaw = searchParams.get("to") || "";
  if (fromRaw !== "" || toRaw !== "") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromRaw) || !/^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
      return { error: "from and to must be YYYY-MM-DD" };
    }
    const f = fromRaw.split("-");
    const t = toRaw.split("-");
    const since = Math.floor(Date.UTC(Number(f[0]), Number(f[1]) - 1, Number(f[2])) / 1000);
    const toDay = Math.floor(Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2])) / 1000);
    if (!(since <= toDay)) return { error: "from must not be after to" };
    if (toDay - since > 366 * 86400) return { error: "range exceeds 366 days" };
    return { since, until: Math.min(toDay + 86400, now + 1), label: fromRaw + ".." + toRaw, days: 0, from: fromRaw, to: toRaw };
  }
  const period = searchParams.get("period") || "7";
  const days = period === "1" ? 1 : period === "30" ? 30 : 7;
  return { since: now - days * 86400, until: now + 1, label: days + "d", days, from: "", to: "" };
}

export function rangeDays(range) {
  if (range.days) return range.days;
  return Math.max(1, Math.round((range.until - range.since) / 86400));
}
