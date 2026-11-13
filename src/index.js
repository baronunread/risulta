import { annotationInput, siteAnnotations } from "./annotations.js";
import { INGEST_CORS, ingestPreflight, createDomainMismatchLogger } from "./ingest-http.js";
import { widgetAllowed, widgetData, widgetPage } from "./public-widgets.js";
import { runMaintenance } from "./maintenance.js";
import { registerMigrateRoutes } from "./migrate.js";
import { shared, store, orgOfSite, listOrgs, DEFAULT_ORG } from "./data.js";
import { analyticsTrace, tracedAnalyticsResponse } from "./analytics-trace.js";
import { cachedAnalytics } from "./analytics-cache.js";
import { SCHEMA_VERSION } from "./migrations.ts";
import { siteSlug, availableSiteSlug } from "./sites.ts";
import { reportAnalytics, journeyAnalytics, overviewAnalytics, overviewComparison, invalidateOverview, measurementAnalytics } from "./overview.js";
import { createReadKey, readKeySite } from "./read-api.js";
import { ensureBackupSchema, backupSettings, backupHistory, backupInput, saveBackupSettings, recordBackup } from "./backups.js";
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
  validDomain,
  parseRange,
  statsInput,
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
  homeOverviews,
  removeUser,
  reportCsv,
  siteStats,
  siteCurrent,
  dashboardReport,
  overviewScope,
  siteByKey,
  siteForKey,
  updateProfile,
  visitorId,
  clientIp,
} from "./store.js";
import { incrementCounter, logRequest, metricsText, safeRoute, setLogLevel } from "./metrics.js";
import { asciiJson, fmtInt, optionalEnv } from "./util.js";
import { escapeHtml } from "./util.js";
import {
  accountPage,
  homePage,
  liveFragment,
  loginPage,
  newSitePage,
  pageShell,
  reportsPage,
  journeysPage,
  measurementPage,
  sitePage,
  setupPage,
  trackerStatus,
  siteSettingsPage,
  trackerFor,
  usersPage,
  backupsPage,
  setBackupsEnabled,
  overviewGoalsFragment,
} from "./views.js";
import { journeyInput, siteJourneys } from "./journeys.js";
import { avatarFor } from "./avatar.js";
import { GoalSchema, ProfileSchema, SiteSchema, validate } from "./validation.ts";

// The org store that holds this site's events (see data.js).
function ev(c, site) {
  return store(c.env, orgOfSite(site));
}

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
function ingestThrottle(env, request) {
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
function publicOrigin(env, request, url) {
  const tracker = optionalEnv(env, "RISULTA_TRACKER_ORIGIN");
  if (tracker) return String(tracker).replace(/\/$/, "");
  try {
    const configured = env["RISULTA_BASE_URL"];
    if (configured) return String(configured).replace(/\/$/, "");
  } catch {
    /* fall through to the request origin */
  }
  return url.origin;
}

// At the current compatibility date request.body is a stream, so the text is
// read asynchronously. A string body (test doubles, older runtimes) is used as is.
async function bodyOf(request) {
  const method = request.method;
  if (method !== "POST" && method !== "PUT") return "";
  const body = request.body;
  if (body && !(body instanceof ReadableStream)) return String(body);
  return await request.text();
}

function wantsJsonFrom(request) {
  return (request.headers.get("content-type") || "").indexOf("application/json") !== -1;
}

function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}

const app = new Hono();

// Hosts that serve only the tracker, collector and widget (RISULTA_TRACKER_HOSTS,
// a comma list such as "t.risulta.dev,stats.brnr.dev"). Everything else, login
// and cookies included, answers 404 there, so the session never lives on a host
// whose pages a customer controls. Unset (the default, and every self-hosted
// instance) nothing changes.
const TRACKER_PATHS = /^\/(js\/[A-Za-z0-9_-]+\.js|api\/event\/[A-Za-z0-9_-]+|widget\.js|widget-frame\.js|widget-geist\.woff2|widget-geist-LICENSE\.txt|public\/(widget|data)\/[A-Za-z0-9_-]+|healthz|favicon\.ico)$/;
app.use("*", async (c, next) => {
  const hosts = optionalEnv(c.env, "RISULTA_TRACKER_HOSTS");
  if (hosts && hosts.toLowerCase().split(",").map((h) => h.trim()).includes(new URL(c.req.url).host.toLowerCase()) && !TRACKER_PATHS.test(new URL(c.req.url).pathname)) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  await next();
});

app.use("*", async (c, next) => {
  await ensureBackupSchema(shared(c.env));
  await ensureReady(shared(c.env), store(c.env, DEFAULT_ORG), c.env);
  await next();
});

app.get("/healthz", () => new Response("ok\n", { headers: { "x-risulta-schema-version": String(SCHEMA_VERSION), "x-risulta-maintenance": "builtin" } }));

// Backup pages and routes exist only where the entry point supplies file
// operations (the standalone binary); elsewhere the host owns backups.
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (!backupFiles && (path === "/backups" || path === "/api/backup" || path.indexOf("/api/backup/") === 0)) {
    return path.indexOf("/api/") === 0 ? json({ error: "not found", path }, 404) : new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  await next();
});
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

app.get("/style.css", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/dashboard.js", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/favicon-light.svg", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/favicon-dark.svg", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/site.webmanifest", (c) => c.env.ASSETS.fetch(c.req.raw));

app.get("/widget-geist.woff2", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/widget-geist-LICENSE.txt", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/widget-frame.js", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/widget.js", (c) => c.env.ASSETS.fetch(c.req.raw));
app.get("/public/widget/:key{[A-Za-z0-9_-]+}", async (c) => {
  if (!widgetAllowed(clientIp(c.req.raw),Math.floor(Date.now()/1000))) return json({error:"too many widget requests"},429,{"retry-after":"60"});
  const data = await widgetData(shared(c.env), store(c.env, DEFAULT_ORG), c.req.param("key"), Math.floor(Date.now()/1000));
  const url = new URL(c.req.url);
  const size = ["small","medium","wide"].includes(url.searchParams.get("size")) ? url.searchParams.get("size") : "medium";
  return new Response(widgetPage(data,size,url.searchParams.get("theme")), {status:data ? 200 : 404,headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","content-security-policy":"default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors *"}});
});
app.get("/public/data/:key{[A-Za-z0-9_-]+}", async (c) => {
  if (!widgetAllowed(clientIp(c.req.raw),Math.floor(Date.now()/1000))) return json({error:"too many widget requests"},429,{"retry-after":"60"});
  const data = await widgetData(shared(c.env), store(c.env, DEFAULT_ORG), c.req.param("key"),Math.floor(Date.now()/1000));
  return json(data || {error:"public sharing unavailable"},data ? 200 : 404,{"access-control-allow-origin":"*","cache-control":"no-store"});
});

// Tracker asset: public, cookieless, same behavior as the Bun app.
app.get("/js/:key{[A-Za-z0-9_-]+\\.js}", async (c) => {
  const key = c.req.param("key").slice(0, -3);
  const site = await siteForKey(shared(c.env), key);
  if (!site) return json({ error: "unknown site" }, 404);
  return new Response(trackerFor(key), { headers: { "content-type": "text/javascript;charset=utf-8" } });
});

// Collector: public. Derives the daily salted visitor hash server-side from
// the runtime-resolved client IP + User-Agent; neither input is stored.
// Rejections (400/403) count as rejected events; unknown keys (404) are not
// a site and are not counted, mirroring the Bun app.
const logDomainMismatch = createDomainMismatchLogger((line) => console.warn(line));
function eventJson(data, status, headers) {
  return json(data, status, headers ? { ...INGEST_CORS, ...headers } : INGEST_CORS);
}
app.options("/api/event/:key{[A-Za-z0-9_-]+}", () => ingestPreflight());
app.post("/api/event/:key{[A-Za-z0-9_-]+}", async (c) => {
  const request = c.req.raw;
  const site = await siteForKey(shared(c.env), c.req.param("key"));
  if (!site) return eventJson({ error: "unknown site" }, 404);
  const parsed = parseJson(await bodyOf(request));
  if (!parsed.ok) { incrementCounter("events_rejected_total"); return eventJson({ error: "body must be JSON" }, 400); }
  const input = parsed.value;
  const name = String(input.name || "");
  if (!validEventName(name)) { incrementCounter("events_rejected_total"); return eventJson({ error: "event name is invalid" }, 400); }
  const value = validValue(input.value === undefined ? null : input.value);
  if (value === false) { incrementCounter("events_rejected_total"); return eventJson({ error: "value is out of range" }, 400); }
  const domain = cleanDomain(input.domain);
  if (domain !== site.domain) {
    incrementCounter("events_rejected_total");
    logDomainMismatch(site.domain, domain, Date.now());
    return eventJson({ error: "domain mismatch" }, 403);
  }
  const parts = splitPathAndAttribution(input.path);
  if (parts.path.charAt(0) !== "/") { incrementCounter("events_rejected_total"); return eventJson({ error: "path must start with /" }, 400); }
  const throttle = ingestThrottle(c.env, request);
  if (!throttle.allowed) {
    incrementCounter("rate_limits_total");
    return eventJson({ error: "too many analytics events, try again shortly" }, 429, { "retry-after": String(throttle.retryAfter) });
  }
  const ts = Math.floor(Date.now() / 1000);
  await ev(c, site).prepare(
    "INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      site.id, ts, name, parts.path, referrerHost(input.referrer),
      await visitorId(ev(c, site), site, request),
      parts.source, parts.medium, parts.campaign, parts.content, parts.term, value,
    )
    .run();
  incrementCounter("events_accepted_total");
  return eventJson({ ok: true }, 202);
});

registerMigrateRoutes(app, json);

// Sign-in. Rate-limited per email; JSON callers get codes, forms get the
// page re-rendered with an error.
app.get("/login", async (c) => {
  const existing = await readSession(shared(c.env), c.req.raw);
  if (existing) return redirect("/");
  return new Response(loginPage(""), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.post("/login", async (c) => {
  const request = c.req.raw;
  const body = await bodyOf(request);
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
  const user = await shared(c.env).prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
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
      await shared(c.env).prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), user.id).run();
    } catch {
      /* keep the legacy hash on failure */
    }
  }
  const session = await createSession(shared(c.env), user.id);
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
  // Bearer credentials never become a session and are checked only here.
  const readSite = await readKeySite(shared(c.env), request);
  if (readSite) {
    c.set("readSite", readSite);
    await next();
    c.header("cache-control", "no-store");
    return;
  }
  const session = await readSession(shared(c.env), request);
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
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!csrfValid(session, csrfValue(request, body))) return wantsJson ? json({ error: "csrf mismatch" }, 403) : redirect("/login");
  await destroySession(shared(c.env), request);
  const secure = isSecure(request);
  const expired = expiredSessionCookie(secure);
  if (wantsJson) return json({ ok: true }, 200, { "set-cookie": expired });
  return redirect("/login", expired);
});

app.get("/api/session", (c) => {
  const session = c.get("session");
  return json({ id: session.user_id, email: session.email, displayName: session.display_name, role: session.role, csrf: session.csrf });
});

app.get("/", async (c) => {
  const session = c.get("session");
  const overviews = await homeOverviews(shared(c.env), (orgId) => store(c.env, orgId), session, Math.floor(Date.now() / 1000));
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
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const current = String(parsed.value.current || "");
  const next = String(parsed.value.password || "");
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const user = await shared(c.env).prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
  if (!user || !(await verifyPassword(current, user.password_hash)).ok) return json({ error: "current password is wrong" }, 403);
  if (next.length < 12) return json({ error: "new password needs 12+ characters" }, 400);
  await changePassword(shared(c.env), session, await hashPassword(next));
  if (wantsJson) return json({ ok: true });
  return redirect("/account?changed=1");
});

app.post("/api/account/profile", async (c) => {
  const session = c.get("session");
  const request = c.req.raw;
  const body = await bodyOf(request);
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
    await updateProfile(shared(c.env), session.user_id, displayName, email);
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
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const confirmation = String(parsed.value.confirmation || "");
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  if (confirmation !== "DELETE") {
    if (wantsJson) return json({ error: "type DELETE to confirm account deletion" }, 400);
    return redirect("/account");
  }
  const target = await shared(c.env).prepare("SELECT role FROM users WHERE id = ?").bind(session.user_id).first();
  if (!target) return json({ error: "unknown user" }, 404);
  if (target.role === "admin" && (await adminCount(shared(c.env))) < 2) {
    if (wantsJson) return json({ error: "cannot delete the last administrator" }, 400);
    return redirect("/account");
  }
  await removeUser(shared(c.env), session.user_id);
  await destroySession(shared(c.env), request);
  const secure = isSecure(request);
  const expired = expiredSessionCookie(secure);
  if (wantsJson) return json({ ok: true }, 200, { "set-cookie": expired });
  return redirect("/login", expired);
});

app.get("/users", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return redirect("/");
  const users = (await shared(c.env).prepare(
    "SELECT users.id, users.email, users.display_name, users.role, users.created_at, group_concat(sites.name, ', ') AS sites " +
      "FROM users LEFT JOIN site_users ON site_users.user_id = users.id LEFT JOIN sites ON sites.id = site_users.site_id " +
      "GROUP BY users.id ORDER BY users.created_at, users.id",
  ).all()).results;
  const sites = (await shared(c.env).prepare("SELECT id, name, domain FROM sites ORDER BY name COLLATE NOCASE").all()).results;
  return new Response(usersPage(session, users, sites, new URL(c.req.raw.url).searchParams.get("backup")), { headers: { "content-type": "text/html;charset=utf-8" } });
});

app.post("/api/users", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const request = c.req.raw;
  const body = await bodyOf(request);
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
    userId = await createUser(shared(c.env), email, password, role, siteIds, displayName);
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
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const targetId = Number(c.req.param("id"));
  if (targetId === session.user_id) return json({ error: "cannot delete yourself" }, 400);
  const target = await shared(c.env).prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
  if (!target) return json({ error: "unknown user" }, 404);
  if (target.role === "admin" && (await adminCount(shared(c.env))) < 2) {
    return json({ error: "cannot delete the last administrator" }, 400);
  }
  await removeUser(shared(c.env), targetId);
  if (wantsJson) return json({ ok: true });
  return redirect("/users");
});

app.use("/sites/*", async (c, next) => {
  const url = new URL(c.req.url);
  const match = /^\/sites\/([0-9]+)(\/.*)?$/.exec(url.pathname);
  if (match && c.req.method === "GET") {
    const site = await getSiteForUser(shared(c.env), Number(match[1]), c.get("session"));
    if (site && site.slug) {
      let suffix = match[2] || "";
      if (suffix === "/conversions") suffix = (url.searchParams.get("error") || "").indexOf("funnel-") === 0 ? "/funnels" : "/goals";
      return c.redirect("/sites/" + siteSlug(site) + suffix + url.search, 308);
    }
  }
  await next();
});

app.get("/sites/:id{[a-z0-9-]+}", async (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
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
  range.filters = reportInput(url.searchParams).filters;
  delete range.filters.event;
  range.acquisition = ["source", "campaign", "medium"].indexOf(url.searchParams.get("acquisition")) >= 0 ? url.searchParams.get("acquisition") : "source";
  const analytics = await overviewAnalytics(ev(c, site), site, range, true);
  // Previous-period comparison: the summary for the immediately preceding
  // window of the same length, like the Bun app.
  const comparison = await overviewComparison(ev(c, site), site, { ...range, since: range.since - days * 86400, until: range.since });
  const sites = await listSitesForUser(shared(c.env), session);
  return new Response(sitePage(session, site, sites, analytics, range, days, metric, publicOrigin(c.env, c.req.raw, url), comparison, await siteAnnotations(ev(c, site), site.id, range)),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

async function setupRoute(c, partial) {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
  if (!site) return new Response("Unknown site", { status: 404 });
  const received = !!(await ev(c, site).prepare("SELECT ts FROM events WHERE site_id=? AND name='pageview' ORDER BY ts DESC LIMIT 1").bind(site.id).first());
  const content = partial ? trackerStatus(site, received) : setupPage(session, site, await listSitesForUser(shared(c.env), session), publicOrigin(c.env, c.req.raw, new URL(c.req.url)), received);
  return new Response(content, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
}
app.get("/sites/:id{[a-z0-9-]+}/setup", async (c) => await setupRoute(c, false));
app.get("/sites/:id{[a-z0-9-]+}/partials/setup", async (c) => await setupRoute(c, true));

app.get("/api/sites", async (c) => json(await listSitesForUser(shared(c.env), c.get("session"))));

app.post("/api/sites", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const request = c.req.raw;
  const body = await bodyOf(request);
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
  const exists = await shared(c.env).prepare("SELECT id FROM sites WHERE domain = ?").bind(domain).first();
  if (exists) {
    if (wantsJson) return json({ error: "domain already registered" }, 409);
    return redirect("/sites/new?error=domain-registered");
  }
  const publicKey = randomHex(16);
  const slug = await availableSiteSlug(shared(c.env), domain);
  const res = await shared(c.env).prepare("INSERT INTO sites (name, domain, public_key, slug, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(name, domain, publicKey, slug, Math.floor(Date.now() / 1000))
    .run();
  siteByKey.set(publicKey, { id: Number(res.meta.last_row_id), domain });
  if (wantsJson) return json({ id: res.meta.last_row_id, name, domain, publicKey, slug }, 201);
  return redirect("/sites/" + slug + "/setup");
});

app.post("/api/sites/:id{[0-9]+}/domain", async (c) => {
  const session = c.get("session");
  const request = c.req.raw;
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (session.role !== "admin") return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const id = Number(c.req.param("id"));
  const site = await shared(c.env).prepare("SELECT id, name, domain, public_key, slug FROM sites WHERE id = ?").bind(id).first();
  if (!site) return json({ error: "unknown site" }, 404);
  const domain = cleanDomain(parsed.value.domain);
  if (!validDomain(domain)) {
    if (wantsJson) return json({ error: "domain is invalid" }, 400);
    return redirect("/sites/" + site.slug + "/settings?error=domain-invalid");
  }
  const exists = await shared(c.env).prepare("SELECT id FROM sites WHERE domain = ? AND id <> ?").bind(domain, id).first();
  if (exists) {
    if (wantsJson) return json({ error: "domain already registered" }, 409);
    return redirect("/sites/" + site.slug + "/settings?error=domain-registered");
  }
  await shared(c.env).prepare("UPDATE sites SET domain = ? WHERE id = ?").bind(domain, id).run();
  siteByKey.set(site.public_key, { id, domain });
  if (wantsJson) return json({ id, name: site.name, domain, publicKey: site.public_key, slug: site.slug });
  return redirect("/sites/" + site.slug + "/settings?saved=1");
});

function measurementReturn(site, kind, body) {
  const query = new URLSearchParams(new URLSearchParams(body).get("return_query") || "");
  const names = ["period", "from", "to", "source", "path", "medium", "campaign"];
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const value = query.get(names[i]);
    if (value) parts.push(names[i] + "=" + encodeURIComponent(value.slice(0, 2048)));
  }
  return "/sites/" + siteSlug(site) + "/" + kind + (parts.length ? "?" + parts.join("&") : "");
}
function measurementError(url, error) {
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "error=" + error;
}

// Credential management stays behind the session gate and admin boundary.
app.get("/api/sites/:id{[0-9]+}/read-keys", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return json({ error: "forbidden" }, 403);
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  return json((await shared(c.env).prepare("SELECT id, site_id, created_at FROM read_api_keys WHERE site_id = ? ORDER BY id").bind(site.id).all()).results, 200, { "cache-control": "no-store" });
});

app.post("/api/sites/:id{[0-9]+}/read-keys", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return json({ error: "forbidden" }, 403);
  const request = c.req.raw;
  if (!csrfValid(session, csrfValue(request, await bodyOf(request)))) return json({ error: "csrf mismatch" }, 403);
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  return json(await createReadKey(shared(c.env), site.id), 201, { "cache-control": "no-store" });
});

app.post("/api/sites/:id{[0-9]+}/read-keys/:keyId{[0-9]+}/revoke", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return json({ error: "forbidden" }, 403);
  const request = c.req.raw;
  if (!csrfValid(session, csrfValue(request, await bodyOf(request)))) return json({ error: "csrf mismatch" }, 403);
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const keyId = Number(c.req.param("keyId"));
  const key = await shared(c.env).prepare("SELECT id FROM read_api_keys WHERE site_id = ? AND id = ?").bind(site.id, keyId).first();
  if (!key) return json({ error: "unknown key" }, 404);
  await shared(c.env).prepare("DELETE FROM read_api_keys WHERE site_id = ? AND id = ?").bind(site.id, keyId).run();
  return json({ ok: true }, 200, { "cache-control": "no-store" });
});

// Goals per site (writes are admin-only; reads follow site access).
app.get("/api/sites/:id{[0-9]+}/goals", async (c) => {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  return json((await ev(c, site).prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all()).results);
});

app.post("/api/sites/:id{[0-9]+}/goals", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const request = c.req.raw;
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const name = String(parsed.value.name || "").trim().slice(0, 80);
  const eventName = String(parsed.value.eventName || parsed.value.event_name || "").trim().slice(0, 64);
  const goalPath = String(parsed.value.path || "").trim().slice(0, 2048);
  const goalUrl = measurementReturn(site, "goals", body);
  const goalCheck = validate(GoalSchema, { name, eventName, path: goalPath });
  if (!goalCheck.ok) {
    const messages = {
      "goal-name-required": "name is required",
      "goal-event-invalid": "event name is invalid",
      "goal-path-invalid": "path must start with /",
    };
    if (wantsJson) return json({ error: messages[goalCheck.code] }, 400);
    return redirect(measurementError(goalUrl, goalCheck.code));
  }
  try {
    await ev(c, site).prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(site.id, name, eventName, goalPath, Math.floor(Date.now() / 1000))
      .run();
  } catch {
    if (wantsJson) return json({ error: "goal name already exists for this site" }, 409);
    return redirect(measurementError(goalUrl, "goal-name-registered"));
  }
  invalidateOverview(ev(c, site), site.id);
  if (wantsJson) return json({ ok: true, name, eventName, path: goalPath }, 201);
  return redirect(goalUrl);
});

// Funnels per site: ordered goal sequences with per-step conversions. Writes
// are admin-only; reads follow site access (via analytics).
app.get("/api/sites/:id{[0-9]+}/funnels", async (c) => {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  return json(await listFunnels(ev(c, site), site.id));
});

app.post("/api/sites/:id{[0-9]+}/funnels", async (c) => {
  const session = c.get("session");
  const isAdmin = session.role === "admin";
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const request = c.req.raw;
  const body = await bodyOf(request);
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
    goalIds = form.getAll("goal").filter((value) => value !== "").map(Number);
  }
  const settingsUrl = measurementReturn(site, "funnels", body);
  if (!name) {
    if (wantsJson) return json({ error: "name is required" }, 400);
    return redirect(measurementError(settingsUrl, "funnel-name-required"));
  }
  const siteGoals = (await ev(c, site).prepare("SELECT id FROM goals WHERE site_id = ?").bind(site.id).all()).results;
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
    return redirect(measurementError(settingsUrl, "funnel-steps-invalid"));
  }
  try {
    await createFunnel(ev(c, site), site.id, name, goalIds);
  } catch {
    if (wantsJson) return json({ error: "unable to save this funnel" }, 409);
    return redirect(measurementError(settingsUrl, "funnel-save-failed"));
  }
  invalidateOverview(ev(c, site), site.id);
  if (wantsJson) return json({ ok: true, name }, 201);
  return redirect(settingsUrl);
});

app.post("/api/sites/:id{[0-9]+}/public-widget", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return json({error:"forbidden"},403);
  const request = c.req.raw;
  const body = await bodyOf(request);
  if (!csrfValid(session,csrfValue(request,body))) return json({error:"csrf mismatch"},403);
  const site = await getSiteForUser(shared(c.env),Number(c.req.param("id")),session);
  if (!site) return json({error:"unknown site"},404);
  const parsed = inputFrom(body,wantsJsonFrom(request));
  if (!parsed.ok) return json({error:"invalid body"},400);
  const enabled = parsed.value.enabled === "1" || parsed.value.enabled === true ? 1 : 0;
  await shared(c.env).prepare("INSERT INTO public_widgets(site_id,enabled) VALUES(?,?) ON CONFLICT(site_id) DO UPDATE SET enabled=excluded.enabled").bind(site.id,enabled).run();
  return wantsJsonFrom(request) ? json({ok:true,enabled:enabled===1}) : redirect("/sites/"+siteSlug(site)+"/settings");
});

// Site configuration keeps the existing site identity and analytics.
async function annotationWrite(c, removing) {
  const session = c.get("session");
  const request = c.req.raw;
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (session.role !== "admin") return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const annotationId = Number(c.req.param("annotationId") || 0);
  if (annotationId && !(await ev(c, site).prepare("SELECT id FROM annotations WHERE id=? AND site_id=?").bind(annotationId, site.id).first())) return json({ error: "unknown annotation" }, 404);
  const returnUrl = "/sites/" + siteSlug(site) + "/settings";
  if (removing) {
    await ev(c, site).prepare("DELETE FROM annotations WHERE id=? AND site_id=?").bind(annotationId, site.id).run();
  } else {
    const parsed = inputFrom(body, wantsJson);
    if (!parsed.ok) return json({ error: "invalid body" }, 400);
    const input = annotationInput(parsed.value);
    if (input.error) return wantsJson ? json({ error: input.error }, 400) : redirect(returnUrl + "?error=annotation-invalid");
    if (annotationId) await ev(c, site).prepare("UPDATE annotations SET ts=?,text=? WHERE id=? AND site_id=?").bind(input.ts, input.text, annotationId, site.id).run();
    else {
      const total = Number((await ev(c, site).prepare("SELECT count(*) AS n FROM annotations WHERE site_id=?").bind(site.id).first()).n);
      if (total >= 500) return wantsJson ? json({ error: "This website has reached its 500-note limit." }, 409) : redirect(returnUrl + "?error=annotation-limit");
      await ev(c, site).prepare("INSERT INTO annotations(site_id,ts,text) VALUES(?,?,?)").bind(site.id, input.ts, input.text).run();
    }
  }
  return wantsJson ? json({ ok: true }) : redirect(returnUrl + "?annotation=saved#annotations");
}
app.post("/api/sites/:id{[0-9]+}/annotations", async (c) => await annotationWrite(c, false));
app.post("/api/sites/:id{[0-9]+}/annotations/:annotationId{[0-9]+}", async (c) => await annotationWrite(c, false));
app.post("/api/sites/:id{[0-9]+}/annotations/:annotationId{[0-9]+}/delete", async (c) => await annotationWrite(c, true));

app.get("/sites/:id{[a-z0-9-]+}/settings", async (c) => {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
  if (!site) return new Response("Unknown site", { status: 404 });
  const url = new URL(c.req.url);
  const error = url.searchParams.get("error") === "domain-invalid" ? "Enter a valid hostname." :
    url.searchParams.get("error") === "domain-registered" ? "That hostname is already used by another website." :
    url.searchParams.get("error") === "annotation-invalid" ? "Choose a valid date and write a note between 1 and 240 characters." :
    url.searchParams.get("error") === "annotation-limit" ? "This website has reached its 500-note limit." : "";
  return new Response(siteSettingsPage(session, site, await listSitesForUser(shared(c.env), session), error, url.searchParams.has("saved"), await shared(c.env).prepare("SELECT enabled FROM public_widgets WHERE site_id=?").bind(site.id).first(), publicOrigin(c.env, c.req.raw, url), await siteAnnotations(ev(c, site), site.id), { size: ["small", "medium", "wide"].includes(url.searchParams.get("size")) ? url.searchParams.get("size") : "medium", theme: ["light", "dark", "auto"].includes(url.searchParams.get("theme")) ? url.searchParams.get("theme") : "auto" }),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

async function measurementRoute(c, kind) {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
  if (!site) return new Response("Unknown site", { status: 404 });
  const url = new URL(c.req.url);
  const range = parseRange(url.searchParams, Math.floor(Date.now() / 1000));
  if (range.error) return new Response(range.error, { status: 400 });
  range.filters = reportInput(url.searchParams).filters;
  delete range.filters.event;
  const configuredGoals = (await ev(c, site).prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all()).results;
  const result = await measurementAnalytics(ev(c, site), site, range, kind);
  const goals = result.goals || [];
  const funnels = result.funnels || [];
  const truncated = result.truncated || false;
  return new Response(measurementPage(session, site, await listSitesForUser(shared(c.env), session), configuredGoals, goals, funnels, truncated, range, kind, url.searchParams.get("error") || ""),
    { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
}
app.get("/sites/:id{[a-z0-9-]+}/goals", async (c) => await measurementRoute(c, "goals"));
app.get("/sites/:id{[a-z0-9-]+}/funnels", async (c) => await measurementRoute(c, "funnels"));

app.get("/sites/:id{[a-z0-9-]+}/partials/live", async (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) return json({ error: range.error }, 400);
  const days = rangeDays(range);
  const metricParam = url.searchParams.get("metric") || "visitors";
  const metric = metricParam === "visits" || metricParam === "pageviews" ? metricParam : "visitors";
  range.filters = reportInput(url.searchParams).filters;
  delete range.filters.event;
  range.acquisition = ["source", "campaign", "medium"].indexOf(url.searchParams.get("acquisition")) >= 0 ? url.searchParams.get("acquisition") : "source";
  const analytics = await overviewAnalytics(ev(c, site), site, range, false);
  const comparison = await overviewComparison(ev(c, site), site, { ...range, since: range.since - days * 86400, until: range.since });
  const oobCurrent = '<strong id="live-current-value" data-current hx-swap-oob="true">' + fmtInt(analytics.current) + "</strong>";
  return new Response(oobCurrent + liveFragment(site, analytics, range, days, metric, comparison, await siteAnnotations(ev(c, site), site.id, range)),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

// Goal previews refresh independently from the five-second traffic poll.
app.get("/sites/:id{[a-z0-9-]+}/partials/goals", async (c) => {
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), c.get("session"));
  if (!site) return json({ error: "unknown site" }, 404);
  const q = new URL(c.req.url).searchParams;
  const range = parseRange(q, Math.floor(Date.now() / 1000));
  if (range.error) return json({ error: range.error }, 400);
  range.filters = reportInput(q).filters;
  delete range.filters.event;
  const analytics = await overviewAnalytics(ev(c, site), site, range, true);
  return new Response(overviewGoalsFragment(site, analytics.goals, range, rangeDays(range)),
    { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
});

// Stats: D1-backed summary with 30-minute visit boundary, configured
// conversion goals, and an explicit or period-based range. Per-day rows
// carry their own distinct counts; multi-day totals are visitor-days only
// in the per-day breakdown, never summed.
app.get("/api/sites/:id{[0-9]+}/stats", async (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = c.get("readSite") || (await getSiteForUser(shared(c.env), Number(c.req.param("id")), session));
  if (!site) return json({ error: "unknown site" }, 404);
  const tracing = url.searchParams.get("trace") === "1";
  if (tracing && (!session || session.role !== "admin")) return json({ error: "forbidden" }, 403);
  const trace = tracing ? analyticsTrace(ev(c, site)) : null;
  const db = trace ? trace.db : ev(c, site);
  const fresh = tracing || url.searchParams.get("fresh") === "1";
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) return json({ error: range.error }, 400);
  const sections = statsInput(url.searchParams);
  if (sections.error) return json({ error: sections.error }, 400);
  const analytics = await cachedAnalytics(db, site.id, "stats", range, sections, now, fresh, async () => await siteStats(db, site, range, now, sections, fresh));
  analytics.current = await siteCurrent(db, site.id);
  const payload = { site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...analytics };
  return trace ? tracedAnalyticsResponse(payload, trace) : json(payload);
});

// Bounded report with exact-match filters, sortable and paginated, as JSON
// or CSV download. Generated synchronously; no job queue exists.
app.get("/api/sites/:id{[0-9]+}/report", async (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = c.get("readSite") || (await getSiteForUser(shared(c.env), Number(c.req.param("id")), session));
  if (!site) return json({ error: "unknown site" }, 404);
  const tracing = url.searchParams.get("trace") === "1";
  if (tracing && (!session || session.role !== "admin")) return json({ error: "forbidden" }, 403);
  if (tracing && url.searchParams.get("format") === "csv") return json({ error: "Tracing requires JSON format" }, 400);
  const trace = tracing ? analyticsTrace(ev(c, site)) : null;
  const db = trace ? trace.db : ev(c, site);
  const fresh = tracing || url.searchParams.get("fresh") === "1";
  const now = Math.floor(Date.now() / 1000);
  const range = parseRange(url.searchParams, now);
  if (range.error) return json({ error: range.error }, 400);
  const input = reportInput(url.searchParams);
  const cohort = url.searchParams.get("cohort") === "1";
  const report = await cachedAnalytics(db, site.id, "report", range, [input,cohort], now, fresh, async () => await dashboardReport(db, site, range, input, cohort, now));
  if (String(url.searchParams.get("format") || "") === "csv") {
    return new Response(reportCsv(report), {
      headers: {
        "content-type": "text/csv;charset=utf-8",
        "content-disposition": 'attachment; filename="site-' + site.id + "-" + report.dimension + '.csv"',
      },
    });
  }
  const payload = { site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...report };
  return trace ? tracedAnalyticsResponse(payload, trace) : json(payload);
});

// Full HTML report: dimension tabs, exact-match filters, sortable table,
// pagination, CSV download. Same bounded query as the JSON report.
app.get("/sites/:id{[a-z0-9-]+}/reports", async (c) => {
  const session = c.get("session");
  const url = new URL(c.req.url);
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
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
  range.filters = input.filters;
  const report = await reportAnalytics(ev(c, site), site, range, input, url.searchParams.get("cohort") === "1");
  report.filters = input.filters;
  report.cohort = url.searchParams.get("cohort") === "1";
  range.filters = input.filters;
  const sites = await listSitesForUser(shared(c.env), session);
  return new Response(reportsPage(session, site, sites, report, range, days),
    { headers: { "content-type": "text/html;charset=utf-8" } });
});

// Authenticated, site-scoped read over existing events. No collector changes.
app.get("/api/sites/:id{[0-9]+}/journeys", async (c) => {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), Number(c.req.param("id")), session);
  if (!site) return json({ error: "unknown site" }, 404);
  const params = new URL(c.req.url).searchParams;
  const range = parseRange(params, Math.floor(Date.now() / 1000));
  const input = journeyInput(params);
  if (range.error || input.error) return json({ error: range.error || input.error }, 400);
  return json({ site: { id: site.id, name: site.name, domain: site.domain }, range,
    ...(await siteJourneys(overviewScope(ev(c, site), site.id, range.since, range.until, reportInput(params).filters), site.id, range.since, range.until, input)) }, 200, { "cache-control": "no-store" });
});

app.get("/sites/:id{[a-z0-9-]+}/reports/journeys", async (c) => {
  const session = c.get("session");
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), session);
  const params = new URL(c.req.url).searchParams;
  const range = parseRange(params, Math.floor(Date.now() / 1000));
  const input = journeyInput(params);
  if (!params.get("limit")) input.limit = 10;
  if (!site || range.error || input.error) {
    const message = !site ? "Unknown site" : range.error || input.error;
    return new Response(pageShell("Journeys", session,
      '<main class="shell" id="main"><h1>' + escapeHtml(message) + "</h1></main>", null, []),
      { status: !site ? 404 : 400, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
  }
  range.filters = reportInput(params).filters;
  delete range.filters.event;
  const report = await journeyAnalytics(ev(c, site), site, range, input);
  return new Response(journeysPage(session, site, await listSitesForUser(shared(c.env), session), report, range),
    { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
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
  const body = await bodyOf(request);
  const htmlForm = (request.headers.get("content-type") || "").indexOf("application/x-www-form-urlencoded") === 0 &&
    (request.headers.get("accept") || "").indexOf("text/html") >= 0;
  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (!csrfValid(session, csrfValue(request, body))) return htmlForm ? redirect("/users?backup=csrf") : json({ error: "csrf mismatch" }, 403);
  try {
    const snapshot = await shared(c.env).backup();
    // db.backup() snapshots the one D1 binding today. Once an org's events live in
    // their own store, each store needs its own snapshot and these counts.
    const sharedTables = ["sites", "users", "sessions", "site_users", "read_api_keys", "backup_settings", "backup_history", "public_widgets", "schema_migrations"];
    const eventTables = ["events", "goals", "funnels", "funnel_steps", "annotations", "analytics_rollup_stats_days", "analytics_rollup_hours", "analytics_rollup_events", "analytics_rollup_days", "analytics_rollup_visitors", "analytics_rollup_dimensions", "analytics_rollup_dirty", "analytics_query_cache", "analytics_cache_days", "analytics_cache_config"];
    const counts = {};
    for (let i = 0; i < sharedTables.length; i++) {
      counts[sharedTables[i]] = Number((await shared(c.env).prepare("SELECT count(*) AS n FROM " + sharedTables[i]).first()).n);
    }
    for (let i = 0; i < eventTables.length; i++) {
      counts[eventTables[i]] = Number((await store(c.env, DEFAULT_ORG).prepare("SELECT count(*) AS n FROM " + eventTables[i]).first()).n);
    }
    await recordBackup(shared(c.env), snapshot);
    if (htmlForm) return redirect("/users?backup=success");
    return json({
      ok: true,
      path: snapshot.path,
      bytes: snapshot.bytes,
      manifest: { app: "risulta-sprout", schema_version: SCHEMA_VERSION, created_at: Math.floor(Date.now() / 1000), tables: counts },
    });
  } catch {
    incrementCounter("database_errors_total");
    return htmlForm ? redirect("/users?backup=failed") : json({ error: "backup failed" }, 500);
  }
});

app.get("/sites/:id{[a-z0-9-]+}/conversions", async (c) => {
  const site = await getSiteForUser(shared(c.env), c.req.param("id"), c.get("session"));
  if (!site) return new Response("Unknown site", {status:404});
  return c.redirect("/sites/" + siteSlug(site) + "/goals" + new URL(c.req.url).search, 308);
});

app.get("/backups", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return redirect("/");
  const message = new URL(c.req.url).searchParams.get("saved") === "1" ? "Backup preferences saved." : "";
  return new Response(backupsPage(session, await backupSettings(shared(c.env)), await backupHistory(shared(c.env)), message),
    { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
});

app.get("/api/backup/settings", async (c) => {
  if (c.get("session").role !== "admin") return json({ error: "forbidden" }, 403);
  return json({ settings: await backupSettings(shared(c.env)), history: await backupHistory(shared(c.env)) }, 200, { "cache-control": "no-store" });
});

app.post("/api/backup/settings", async (c) => {
  const session = c.get("session");
  if (session.role !== "admin") return json({ error: "forbidden" }, 403);
  const request = c.req.raw;
  const body = await bodyOf(request);
  const wantsJson = wantsJsonFrom(request);
  if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
  const parsed = inputFrom(body, wantsJson);
  if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
  const input = backupInput(parsed.value);
  if (input.error) return wantsJson ? json({ error: input.error }, 400) : new Response(
    backupsPage(session, await backupSettings(shared(c.env)), await backupHistory(shared(c.env)), input.error, true),
    { status: 400, headers: { "content-type": "text/html;charset=utf-8" } });
  await saveBackupSettings(shared(c.env), input);
  return wantsJson ? json({ ok: true }) : redirect("/backups?saved=1");
});

// Embedded static assets for signed-in pages. The assets directory is the
// URL root; unknown API routes stay JSON.
app.all("*", (c) => {
  const request = c.req.raw;
  const path = new URL(request.url).pathname;
  const apiRoute = path === "/api" || path.indexOf("/api/") === 0;
  if (apiRoute) return json({ error: "not found", path }, 404);
  if (request.method === "GET") return c.env.ASSETS.fetch(request);
  return json({ error: "not found", path }, 404);
});

async function routeRequest(request, env, ctx) {
  const startedAt = Date.now();
  setLogLevel(optionalEnv(env, "RISULTA_LOG_LEVEL"));
  let response;
  try {
    response = await app.fetch(request, env, ctx);
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

// Every-minute tick: scheduled backup (only where the entry point supplies
// file operations, i.e. the standalone binary) and a bounded rollup pass, all
// in this process. A tick that is still running makes the next one a no-op.
let maintenanceRunning = false;
async function runScheduled(env) {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  setLogLevel(optionalEnv(env, "RISULTA_LOG_LEVEL"));
  const startedAt = Date.now();
  try {
    await ensureBackupSchema(shared(env));
    await ensureReady(shared(env), store(env, DEFAULT_ORG), env);
    const result = await runMaintenance(shared(env), (orgId) => store(env, orgId), await listOrgs(shared(env)), backupFiles, Math.floor(startedAt / 1000));
    console.log(JSON.stringify({ type: "maintenance", backup: result.backup, days: result.days, ms: Date.now() - startedAt }));
    if (result.failed) incrementCounter("database_errors_total");
  } catch (error) {
    incrementCounter("database_errors_total");
    console.error("Maintenance failed: " + String(error));
  } finally {
    maintenanceRunning = false;
  }
}

// The Workers module shape: fetch(request, env, ctx) and scheduled(controller,
// env, ctx). `options.backupFiles` is the one standalone-only capability
// (publish and prune backup files); without it, backups are left to the host.
let backupFiles = null;
export function createRisulta(options) {
  backupFiles = options && options.backupFiles ? options.backupFiles : null;
  setBackupsEnabled(!!backupFiles);
  return {
    async scheduled(controller, env) {
      return await runScheduled(env);
    },
    async fetch(request, env, ctx) {
      return await routeRequest(request, env, ctx);
    },
  };
}
