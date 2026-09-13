// Risulta Sprout: request router. Thin by design (sproutboat-site shape):
// domain rules live in domain.js, storage in store.js, auth in auth.js,
// pages in views.js, charts in chart.js. Hono is routing only - never call
// its parseBody()/formData(); they crash this runtime's process outright.
import { Hono } from "hono";
import {
  changePassword,
  clearLoginFailures,
  createSession,
  createUser,
  csrfValid,
  csrfValue,
  destroySession,
  expiredSessionCookie,
  hashPassword,
  loginAllowed,
  loginRateLimitKeys,
  normalizeEmail,
  randomHex,
  readSession,
  recordLoginFailure,
  setSessionCookie,
  verifyPassword,
} from "./auth.js";
import {
  cleanDomain,
  parseRange,
  rangeDays,
  referrerHost,
  splitPathAndAttribution,
  validEventName,
  validValue,
} from "./domain.js";
import {
  adminCount,
  createFunnel,
  ensureReady,
  getSiteForUser,
  listFunnels,
  listSitesForUser,
  removeUser,
  reportCsv,
  siteAnalytics,
  siteByKey,
  siteForKey,
  siteReport,
  siteSummary,
  updateProfile,
  visitorId,
  clientIp,
} from "./store.js";
import { incrementCounter, logRequest, metricsText, safeRoute } from "./metrics.js";
import { asciiJson, fmtInt } from "./util.js";
import { escapeHtml } from "./util.js";
import {
  accountPage,
  homePage,
  liveFragment,
  loginPage,
  newSitePage,
  pageShell,
  reportsPage,
  settingsPage,
  sitePage,
  trackerFor,
  usersPage,
} from "./views.js";
import { avatarFor } from "./avatar.js";
import { GoalSchema, ProfileSchema, SiteSchema, validate } from "./validation.js";

function json(data, status, headers) {
  const responseHeaders = { "content-type": "application/json" };
  if (headers) {
    for (const name in headers) responseHeaders[name] = headers[name];
  }
  // ASCII-only serialization: the runtime emits Latin-1-range strings as
  // raw bytes, which would corrupt non-English text on the wire.
  return new Response(asciiJson(data), {
    status: status || 200,
    headers: responseHeaders,
  });
}

function parseJson(body) {
  try {
    return { ok: true, value: JSON.parse(body || "{}") };
  } catch {
    return { ok: false, value: {} };
  }
}

// URLSearchParams has no .entries()/iterator on this runtime, only .get()
// and .forEach() - first-wins here to match what repeated .get(key) calls
// would each return.
function formToObject(usp) {
  const out = {};
  usp.forEach((value, key) => {
    if (!(key in out)) out[key] = value;
  });
  return out;
}

// Single-value form/JSON bodies only - a route with a checkbox list
// (form.getAll(...)) parses the form itself instead.
function inputFrom(body, wantsJson) {
  return wantsJson ? parseJson(body) : { ok: true, value: formToObject(new URLSearchParams(body)) };
}

// Same-origin check for unauthenticated form/JSON writes (login). Compares
// hosts only, not schemes: TLS terminates at the proxy, so the browser's
// https origin never equals the binary's http origin. Missing Origin (curl,
// non-browser clients) passes like the Bun app.
function sameOriginHost(request) {
  const origin = request.headers.get("origin") || "";
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const host = String(request.headers.get("host") || "").split(",")[0].trim().toLowerCase();
    return originHost !== "" && originHost === host;
  } catch {
    return false;
  }
}

function redirect(to, cookie) {
  const headers = { location: to };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response("", { status: 303, headers });
}

// Per-IP ingest throttle through the INGEST rate-limit binding (declared in
// sproutboat.jsonc, 240 events per 60 s window like the Bun app). Fails open
// only when the binding is undeclared; production builds declare it and
// verify.sh proves the 429 path. The binding returns { success, resetAt }
// (epoch ms of the window roll), so Retry-After is exact.
let ingestBindingWarned = false;
function ingestThrottle(request) {
  const binding = env.INGEST;
  const limit = binding ? binding.limit : null;
  if (limit) {
    try {
      const result = limit.call(binding, { key: clientIp(request) || "unknown" });
      if (result && result.success === false) {
        const resetAt = result.resetAt;
        const retryAfter = resetAt > Date.now() ? Math.ceil((resetAt - Date.now()) / 1000) : 60;
        return { allowed: false, retryAfter: Math.max(1, retryAfter) };
      }
      return { allowed: true, retryAfter: 0 };
    } catch {
      return { allowed: true, retryAfter: 0 };
    }
  }
  if (!ingestBindingWarned) {
    ingestBindingWarned = true;
    try {
      console.error(JSON.stringify({ time_ms: Date.now(), type: "warning", message: "INGEST rate-limit binding is not declared; ingest is unthrottled" }));
    } catch {
      /* ignore */
    }
  }
  return { allowed: true, retryAfter: 0 };
}

// Shared report input parsing for the JSON/CSV API and the HTML page:
// dimension plus exact-match filters, limit, offset and sort. Bounds are
// enforced inside siteReport.
function reportInput(q) {
  const filters = {};
  const pathFilter = String(q.get("path") || "").slice(0, 2048);
  const sourceFilter = String(q.get("source") || "").slice(0, 128);
  const mediumFilter = String(q.get("medium") || "").slice(0, 128);
  const campaignFilter = String(q.get("campaign") || "").slice(0, 128);
  const eventFilter = String(q.get("event") || "").slice(0, 64);
  if (pathFilter !== "") filters.path = pathFilter;
  if (sourceFilter !== "") filters.source = sourceFilter;
  if (mediumFilter !== "") filters.medium = mediumFilter;
  if (campaignFilter !== "") filters.campaign = campaignFilter;
  if (eventFilter !== "") filters.event = eventFilter;
  return {
    dimension: String(q.get("dimension") || "path"),
    filters,
    limit: q.get("limit"),
    offset: q.get("offset"),
    sort: String(q.get("sort") || "visitors"),
  };
}

// Public origin for tracker snippets. An explicit RISULTA_BASE_URL wins
// (required behind a TLS-terminating proxy, where the request origin is
// loopback); otherwise the request origin, which is correct for direct
// loopback use.
function publicOrigin(request, url) {
  try {
    const configured = env["RISULTA_BASE_URL"];
    if (configured) return String(configured).replace(/\/$/, "");
  } catch {
    /* fall through to the request origin */
  }
  return url.origin;
}

function bodyOf(request) {
  const method = request.method;
  return method === "POST" || method === "PUT" ? request.body || "" : "";
}

function wantsJsonFrom(request) {
  return (request.headers.get("content-type") || "").indexOf("application/json") !== -1;
}

function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}

const app = new Hono();

app.use("*", async (c, next) => {
  await ensureReady(env.DB);
  await next();
});

app.get("/healthz", () => new Response("ok\n"));
app.get("/favicon.ico", () => new Response("", { status: 204 }));

app.get("/avatar.svg", (c) => {
  const svg = avatarFor(new URL(c.req.url).searchParams.get("name") || "Risulta");
  if (!svg) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=300" } });
});

// Operational counters in Prometheus exposition. Unauthenticated by design
// like the Bun app: the binary binds loopback, so this is network-restricted.
// Do not route /metrics through a public proxy.
app.get("/metrics", () =>
  new Response(metricsText(loginRateLimitKeys()), {
    headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" },
  }));

app.get("/style.css", (c) => env.ASSETS.fetch(c.req.raw));
app.get("/dashboard.js", (c) => env.ASSETS.fetch(c.req.raw));
app.get("/favicon-light.svg", (c) => env.ASSETS.fetch(c.req.raw));
app.get("/favicon-dark.svg", (c) => env.ASSETS.fetch(c.req.raw));
app.get("/site.webmanifest", (c) => env.ASSETS.fetch(c.req.raw));

// Tracker asset: public, cookieless, same behavior as the Bun app.
app.get("/js/:key{[A-Za-z0-9_-]+\\.js}", (c) => {
  const key = c.req.param("key").slice(0, -3);
  const site = siteForKey(env.DB, key);
  if (!site) return json({ error: "unknown site" }, 404);
  return new Response(trackerFor(key), { headers: { "content-type": "text/javascript;charset=utf-8" } });
});

// Collector: public. Derives the daily salted visitor hash server-side from
// the runtime-resolved client IP + User-Agent; neither input is stored.
// Rejections (400/403) count as rejected events; unknown keys (404) are not
// a site and are not counted, mirroring the Bun app.
app.post("/api/event/:key{[A-Za-z0-9_-]+}", async (c) => {
  const request = c.req.raw;
  const site = siteForKey(env.DB, c.req.param("key"));
  if (!site) return json({ error: "unknown site" }, 404);
  const parsed = parseJson(bodyOf(request));
  if (!parsed.ok) { incrementCounter("events_rejected_total"); return json({ error: "body must be JSON" }, 400); }
  const input = parsed.value;
  const name = String(input.name || "");
  if (!validEventName(name)) { incrementCounter("events_rejected_total"); return json({ error: "event name is invalid" }, 400); }
  const value = validValue(input.value === undefined ? null : input.value);
  if (value === false) { incrementCounter("events_rejected_total"); return json({ error: "value is out of range" }, 400); }
  const domain = cleanDomain(input.domain);
  if (domain !== site.domain) { incrementCounter("events_rejected_total"); return json({ error: "domain mismatch" }, 403); }
  const parts = splitPathAndAttribution(input.path);
  if (parts.path.charAt(0) !== "/") { incrementCounter("events_rejected_total"); return json({ error: "path must start with /" }, 400); }
  const throttle = ingestThrottle(request);
  if (!throttle.allowed) {
    incrementCounter("rate_limits_total");
    return json({ error: "too many analytics events, try again shortly" }, 429, { "retry-after": String(throttle.retryAfter) });
  }
  const ts = Math.floor(Date.now() / 1000);
  env.DB.prepare(
    "INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      site.id, ts, name, parts.path, referrerHost(input.referrer),
      await visitorId(env.DB, site, request),
      parts.source, parts.medium, parts.campaign, parts.content, parts.term, value,
    )
    .run();
  incrementCounter("events_accepted_total");
  return json({ ok: true }, 202);
});

// Sign-in. Rate-limited per email; JSON callers get codes, forms get the
// page re-rendered with an error.
app.get("/login", async (c) => {
  const existing = await readSession(env.DB, c.req.raw);
  if (existing) return redirect("/");
  return new Response(loginPage(""), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.post("/login", async (c) => {
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!sameOriginHost(request)) {
    if (wantsJson) return json({ error: "forbidden" }, 403);
    return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const email = normalizeEmail(parsed.value.email);
  const password = String(parsed.value.password || "");
  if (!loginAllowed(email)) {
    incrementCounter("rate_limits_total");
    if (wantsJson) return json({ error: "too many attempts, try later" }, 429);
    return new Response(loginPage("Too many attempts, try again later."), { headers: { "content-type": "text/html;charset=utf-8" } });
  }
  const user = env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  const check = user ? await verifyPassword(password, user.password_hash) : { ok: false, rehash: false };
  if (!user || !check.ok) {
    incrementCounter("auth_failures_total");
    recordLoginFailure(email);
    if (wantsJson) return json({ error: "invalid email or password" }, 401);
    return new Response(loginPage("Invalid email or password."), { headers: { "content-type": "text/html;charset=utf-8" } });
  }
  clearLoginFailures(email);
  if (check.rehash) {
    // Legacy row (s2$ standalone or Bun scrypt$): upgrade to the current KDF
    // now that the password is proven.
    try {
      env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), user.id).run();
    } catch {
      /* keep the legacy hash on failure */
    }
  }
  const session = await createSession(env.DB, user.id);
  const secure = isSecure(request);
  const cookie = setSessionCookie(session.token, secure);
  if (wantsJson) return json({ ok: true }, 200, { "set-cookie": cookie });
  return redirect("/", cookie);
});

// Gates every route registered below this point: API callers get 401 JSON,
// browsers get redirected to sign in.
app.use("*", async (c, next) => {
  const request = c.req.raw;
  const path = new URL(request.url).pathname;
  const session = await readSession(env.DB, request);
  const apiRoute = path === "/api" || path.indexOf("/api/") === 0;
  if (!session) {
    if (apiRoute) return json({ error: "sign in required" }, 401);
    return redirect("/login");
  }
  c.set("session", session);
  await next();
});

app.post("/logout", async (c) => {
  const session = c.get("session");
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!csrfValid(session, csrfValue(request, body))) return wantsJson ? json({ error: "csrf mismatch" }, 403) : redirect("/login");
  await destroySession(env.DB, request);
  const secure = isSecure(request);
  const expired = expiredSessionCookie(secure);
  if (wantsJson) return json({ ok: true }, 200, { "set-cookie": expired });
  return redirect("/login", expired);
});

app.get("/api/session", (c) => {
  const session = c.get("session");
  return json({ id: session.user_id, email: session.email, displayName: session.display_name, role: session.role, csrf: session.csrf });
});

app.get("/", (c) => {
  const session = c.get("session");
  const sites = listSitesForUser(env.DB, session);
  const now = Math.floor(Date.now() / 1000);
  const overviews = [];
  for (let i = 0; i < sites.length; i++) {
    const summary = siteSummary(env.DB, sites[i].id, now - 7 * 86400, now + 1);
    overviews.push({ id: sites[i].id, name: sites[i].name, domain: sites[i].domain, overview: { visitors: Number(summary.visitors), pageviews: Number(summary.pageviews) } });
  }
  return new Response(homePage(session, overviews), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.get("/sites/new", (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return redirect("/");
  const error = new URL(c.req.url).searchParams.get("error") || "";
  return new Response(newSitePage(session, error), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.get("/account", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const changed = (url.searchParams.get("changed") || "") === "1";
  const profile = url.searchParams.get("profile") || "";
  return new Response(accountPage(session, { changed, profile }), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.post("/api/account/password", async (c) => {
  const session = c.get("session");
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const current = String(parsed.value.current || "");
  const next = String(parsed.value.password || "");
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const user = env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
  if (!user || !(await verifyPassword(current, user.password_hash)).ok) return json({ error: "current password is wrong" }, 403);
  if (next.length < 12) return json({ error: "new password needs 12+ characters" }, 400);
  changePassword(env.DB, session, await hashPassword(next));
  if (wantsJson) return json({ ok: true });
  return redirect("/account?changed=1");
});

app.post("/api/account/profile", async (c) => {
  const session = c.get("session");
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const displayName = String(parsed.value.displayName || parsed.value.display_name || "").trim().slice(0, 80);
  const email = normalizeEmail(parsed.value.email);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const profileCheck = validate(ProfileSchema, { displayName, email });
  if (!profileCheck.ok) {
    const messages = { "name-required": "display name is required", "email-invalid": "email is invalid" };
    if (wantsJson) return json({ error: messages[profileCheck.code] }, 400);
    return redirect("/account?profile=" + profileCheck.code);
  }
  try {
    updateProfile(env.DB, session.user_id, displayName, email);
  } catch {
    if (wantsJson) return json({ error: "email already registered" }, 409);
    return redirect("/account?profile=email-registered");
  }
  if (wantsJson) return json({ ok: true });
  return redirect("/account?profile=1");
});

app.post("/api/account/delete", async (c) => {
  const session = c.get("session");
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const confirmation = String(parsed.value.confirmation || "");
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  if (confirmation !== "DELETE") {
    if (wantsJson) return json({ error: "type DELETE to confirm account deletion" }, 400);
    return redirect("/account");
  }
  const target = env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(session.user_id).first();
  if (!target) return json({ error: "unknown user" }, 404);
  if (target.role === "admin" && adminCount(env.DB) < 2) {
    if (wantsJson) return json({ error: "cannot delete the last administrator" }, 400);
    return redirect("/account");
  }
  removeUser(env.DB, session.user_id);
  await destroySession(env.DB, request);
  const secure = isSecure(request);
  const expired = expiredSessionCookie(secure);
  if (wantsJson) return json({ ok: true }, 200, { "set-cookie": expired });
  return redirect("/login", expired);
});

app.get("/users", (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return redirect("/");
  const users = env.DB.prepare(
    "SELECT users.id, users.email, users.display_name, users.role, users.created_at, group_concat(sites.name, ', ') AS sites " +
      "FROM users LEFT JOIN site_users ON site_users.user_id = users.id LEFT JOIN sites ON sites.id = site_users.site_id " +
      "GROUP BY users.id ORDER BY users.created_at, users.id",
  ).all().results;
  const sites = env.DB.prepare("SELECT id, name, domain FROM sites ORDER BY name COLLATE NOCASE").all().results;
  return new Response(usersPage(session, users, sites), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.post("/api/users", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  let email = "";
  let displayName = "";
  let password = "";
  let role = "viewer";
  let siteIds = [];
  if (wantsJson) {
    const parsed = parseJson(body);
    if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
    const input = parsed.value;
    email = normalizeEmail(input.email);
    displayName = String(input.displayName || input.display_name || "").trim().slice(0, 80);
    password = String(input.password || "");
    role = input.role === "admin" ? "admin" : "viewer";
    siteIds = (input.siteIds || input.site_ids || []).map(Number);
  } else {
    const form = new URLSearchParams(body);
    email = normalizeEmail(form.get("email"));
    displayName = String(form.get("display_name") || "").trim().slice(0, 80);
    password = String(form.get("password") || "");
    role = form.get("role") === "admin" ? "admin" : "viewer";
    siteIds = form.getAll("site").map(Number);
  }
  if (!email) {
    if (wantsJson) return json({ error: "email is required" }, 400);
    return redirect("/users");
  }
  if (password.length < 12) {
    if (wantsJson) return json({ error: "password needs 12+ characters" }, 400);
    return redirect("/users");
  }
  let userId = 0;
  try {
    userId = await createUser(env.DB, email, password, role, siteIds, displayName);
  } catch {
    if (wantsJson) return json({ error: "email already registered" }, 409);
    return redirect("/users");
  }
  if (wantsJson) return json({ ok: true, id: userId, email, role }, 201);
  return redirect("/users");
});

app.post("/api/users/:id{[0-9]+}/delete", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const targetId = Number(c.req.param("id"));
  if (targetId === session.user_id) return json({ error: "cannot delete yourself" }, 400);
  const target = env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
  if (!target) return json({ error: "unknown user" }, 404);
  if (target.role === "admin" && adminCount(env.DB) < 2) {
    return json({ error: "cannot delete the last administrator" }, 400);
  }
  removeUser(env.DB, targetId);
  if (wantsJson) return json({ ok: true });
  return redirect("/users");
});

app.get("/sites/:id{[0-9]+}", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) {
    return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>Unknown site</h1></main>', null, []),
      { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
  }
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) {
    return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>' + escapeHtml(range.error) + "</h1></main>", null, []),
      { status: 400, headers: { "content-type": "text/html;charset=utf-8" } });
  }
  const days = rangeDays(range);
  const metricParam = url.searchParams.get("metric") || "visitors";
  const metric = metricParam === "visits" || metricParam === "pageviews" ? metricParam : "visitors";
  const analytics = siteAnalytics(env.DB, site, range.since, range.until);
  // Previous-period comparison: the summary for the immediately preceding
  // window of the same length, like the Bun app.
  let comparison = null;
  if (url.searchParams.get("compare") === "1") {
    comparison = siteSummary(env.DB, site.id, range.since - days * 86400, range.since);
  }
  const sites = listSitesForUser(env.DB, session);
  return new Response(sitePage(session, site, sites, analytics, range, days, metric, publicOrigin(c.req.raw, url), comparison),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.get("/api/sites", (c) => json(listSitesForUser(env.DB, c.get("session"))));

app.post("/api/sites", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const name = String(parsed.value.name || "").trim().slice(0, 80);
  const domain = cleanDomain(parsed.value.domain);
  const siteCheck = validate(SiteSchema, { name, domain });
  if (!siteCheck.ok) {
    const messages = { "name-required": "name is required", "domain-invalid": "domain is invalid" };
    if (wantsJson) return json({ error: messages[siteCheck.code] }, 400);
    return redirect("/sites/new?error=" + siteCheck.code);
  }
  const exists = env.DB.prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
  if (exists) {
    if (wantsJson) return json({ error: "domain already registered" }, 409);
    return redirect("/sites/new?error=domain-registered");
  }
  const publicKey = randomHex(16);
  const res = env.DB.prepare("INSERT INTO sites (name, domain, public_key, created_at) VALUES (?, ?, ?, ?)")
    .bind(name, domain, publicKey, Math.floor(Date.now() / 1000))
    .run();
  siteByKey.set(publicKey, { id: Number(res.meta.last_row_id), domain });
  if (wantsJson) return json({ id: res.meta.last_row_id, name, domain, publicKey }, 201);
  return redirect("/sites/" + res.meta.last_row_id);
});

// Goals per site (writes are admin-only; reads follow site access).
app.get("/api/sites/:id{[0-9]+}/goals", (c) => {
  const session = c.get("session");
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  return json(env.DB.prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results);
});

app.post("/api/sites/:id{[0-9]+}/goals", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const name = String(parsed.value.name || "").trim().slice(0, 80);
  const eventName = String(parsed.value.eventName || parsed.value.event_name || "").trim().slice(0, 64);
  const goalPath = String(parsed.value.path || "").trim().slice(0, 2048);
  const goalCheck = validate(GoalSchema, { name, eventName, path: goalPath });
  if (!goalCheck.ok) {
    const messages = {
      "goal-name-required": "name is required",
      "goal-event-invalid": "event name is invalid",
      "goal-path-invalid": "path must start with /",
    };
    if (wantsJson) return json({ error: messages[goalCheck.code] }, 400);
    return redirect("/sites/" + site.id + "/settings?error=" + goalCheck.code);
  }
  try {
    env.DB.prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(site.id, name, eventName, goalPath, Math.floor(Date.now() / 1000))
      .run();
  } catch {
    if (wantsJson) return json({ error: "goal name already exists for this site" }, 409);
    return redirect("/sites/" + site.id + "/settings?error=goal-name-registered");
  }
  if (wantsJson) return json({ ok: true, name, eventName, path: goalPath }, 201);
  return redirect("/sites/" + site.id + "/settings");
});

// Funnels per site: ordered goal sequences with per-step conversions. Writes
// are admin-only; reads follow site access (via analytics).
app.get("/api/sites/:id{[0-9]+}/funnels", (c) => {
  const session = c.get("session");
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  return json(listFunnels(env.DB, site.id));
});

app.post("/api/sites/:id{[0-9]+}/funnels", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const request = c.req.raw;
  const body = bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  let name = "";
  let goalIds = [];
  if (wantsJson) {
    const parsed = parseJson(body);
    if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
    const input = parsed.value;
    name = String(input.name || "").trim().slice(0, 100);
    goalIds = (input.goalIds || input.goal_ids || []).map(Number);
  } else {
    const form = new URLSearchParams(body);
    name = String(form.get("name") || "").trim().slice(0, 100);
    goalIds = form.getAll("goal").map(Number);
  }
  const settingsUrl = "/sites/" + site.id + "/settings";
  if (!name) {
    if (wantsJson) return json({ error: "name is required" }, 400);
    return redirect(settingsUrl + "?error=funnel-name-required");
  }
  const siteGoals = env.DB.prepare("SELECT id FROM goals WHERE site_id = ?").bind(site.id).all().results;
  const validIds = new Set(siteGoals.map((g) => g.id));
  const seen = new Set();
  let stepsOk = goalIds.length >= 2;
  for (const id of goalIds) {
    if (!validIds.has(id) || seen.has(id)) {
      stepsOk = false;
      break;
    }
    seen.add(id);
  }
  if (!stepsOk) {
    if (wantsJson) return json({ error: "select at least two distinct goals of this site" }, 400);
    return redirect(settingsUrl + "?error=funnel-steps-invalid");
  }
  try {
    createFunnel(env.DB, site.id, name, goalIds);
  } catch {
    if (wantsJson) return json({ error: "unable to save this funnel" }, 409);
    return redirect(settingsUrl + "?error=funnel-save-failed");
  }
  if (wantsJson) return json({ ok: true, name }, 201);
  return redirect(settingsUrl);
});

// Website settings: tracker snippet, goal list, funnel management.
app.get("/sites/:id{[0-9]+}/settings", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) {
    return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>Unknown site</h1></main>', null, []),
      { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
  }
  const sites = listSitesForUser(env.DB, session);
  const goals = env.DB.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results;
  const funnels = listFunnels(env.DB, site.id);
  const error = url.searchParams.get("error") || "";
  return new Response(settingsPage(session, site, sites, goals, funnels, error, publicOrigin(c.req.raw, url)),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

// Live fragment for htmx polling: the same server-rendered markup as the
// dashboard's live region, swapped in every few seconds.
app.get("/sites/:id{[0-9]+}/partials/live", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) return json({ error: range.error }, 400);
  const days = rangeDays(range);
  const metricParam = url.searchParams.get("metric") || "visitors";
  const metric = metricParam === "visits" || metricParam === "pageviews" ? metricParam : "visitors";
  const analytics = siteAnalytics(env.DB, site, range.since, range.until);
  let comparison = null;
  if (url.searchParams.get("compare") === "1") {
    comparison = siteSummary(env.DB, site.id, range.since - days * 86400, range.since);
  }
  const oobCurrent = '<strong id="live-current-value" data-current hx-swap-oob="true">' + fmtInt(analytics.current) + "</strong>";
  return new Response(oobCurrent + liveFragment(site, analytics, range, days, metric, comparison),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

// Stats: D1-backed summary with 30-minute visit boundary, configured
// conversion goals, and an explicit or period-based range. Per-day rows
// carry their own distinct counts; multi-day totals are visitor-days only
// in the per-day breakdown, never summed.
app.get("/api/sites/:id{[0-9]+}/stats", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) return json({ error: range.error }, 400);
  const analytics = siteAnalytics(env.DB, site, range.since, range.until);
  return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...analytics });
});

// Bounded report with exact-match filters, sortable and paginated, as JSON
// or CSV download. Generated synchronously; no job queue exists.
app.get("/api/sites/:id{[0-9]+}/report", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) return json({ error: range.error }, 400);
  const input = reportInput(url.searchParams);
  const report = siteReport(
    env.DB, site.id, range.since, range.until,
    input.dimension, input.filters, input.limit, input.offset, input.sort,
  );
  if (String(url.searchParams.get("format") || "") === "csv") {
    return new Response(reportCsv(report), {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": 'attachment; filename="site-' + site.id + "-" + report.dimension + '.csv"',
      },
    });
  }
  return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...report });
});

// Full HTML report: dimension tabs, exact-match filters, sortable table,
// pagination, CSV download. Same bounded query as the JSON report.
app.get("/sites/:id{[0-9]+}/reports", (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = getSiteForUser(env.DB, Number(c.req.param("id")), session);
  if (!site) {
    return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>Unknown site</h1></main>', null, []),
      { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
  }
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) {
    return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>' + escapeHtml(range.error) + "</h1></main>", null, []),
      { status: 400, headers: { "content-type": "text/html;charset=utf-8" } });
  }
  const days = rangeDays(range);
  const input = reportInput(url.searchParams);
  const report = siteReport(
    env.DB, site.id, range.since, range.until,
    input.dimension, input.filters, input.limit, input.offset, input.sort,
  );
  const sites = listSitesForUser(env.DB, session);
  return new Response(reportsPage(session, site, sites, report, range, days),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

// Online backup of the D1 database: an integrity-checked single-file
// snapshot in backups/, no downtime, no WAL sidecars. Admin only. The
// response carries a manifest (row counts per table) so a copied snapshot
// can be audited before a restore. Copy the file off the box; restore by
// putting it back at d1/DB.sqlite on a stopped binary.
app.post("/api/backup", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const request = c.req.raw;
  const body = bodyOf(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  try {
    const snapshot = env.DB.backup();
    const tables = ["sites", "events", "goals", "funnels", "funnel_steps", "users", "sessions", "site_users"];
    const counts = {};
    for (let i = 0; i < tables.length; i++) {
      counts[tables[i]] = Number(env.DB.prepare("SELECT count(*) AS n FROM " + tables[i]).first().n);
    }
    return json({
      ok: true,
      path: snapshot.path,
      bytes: snapshot.bytes,
      manifest: { app: "risulta-sprout", created_at: Math.floor(Date.now() / 1000), tables: counts },
    });
  } catch {
    incrementCounter("database_errors_total");
    return json({ error: "backup failed" }, 500);
  }
});

// Embedded static assets for signed-in pages. The assets directory is the
// URL root; unknown API routes stay JSON.
app.all("*", (c) => {
  const request = c.req.raw;
  const path = new URL(request.url).pathname;
  const apiRoute = path === "/api" || path.indexOf("/api/") === 0;
  if (apiRoute) return json({ error: "not found", path }, 404);
  if (request.method === "GET") return env.ASSETS.fetch(request);
  return json({ error: "not found", path }, 404);
});

async function routeRequest(request) {
  const startedAt = Date.now();
  let response;
  try {
    response = await app.fetch(request);
  } catch {
    incrementCounter("database_errors_total");
    response = json({ error: "internal error" }, 500);
  }
  try {
    logRequest(request.method, safeRoute(new URL(request.url).pathname), response.status, Date.now() - startedAt);
  } catch {
    /* logging must never break a response */
  }
  return response;
}

export default {
  // The runtime resolves a returned promise directly; no .then() chaining on
  // top of it (that shape hangs). Logging and error counting live inside
  // routeRequest so this stays a direct return.
  fetch(request) {
    return routeRequest(request);
  },
};
