// Risulta Sprout: request router. Thin by design (sproutboat-site shape):
// domain rules live in domain.js, storage in store.js, auth in auth.js,
// pages in views.js, charts in chart.js. This file only routes.
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
  validDomain,
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

function json(data, status, headers) {
  const responseHeaders = { "content-type": "application/json" };
  if (headers) {
    for (const name in headers) responseHeaders[name] = headers[name];
  }
  return new Response(JSON.stringify(data), {
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

async function routeInner(request) {
    await ensureReady(env.DB);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const secure = url.protocol === "https:";
    const body = method === "POST" || method === "PUT" ? request.body || "" : "";
    const ctype = request.headers.get("content-type") || "";
    const wantsJson = ctype.indexOf("application/json") !== -1;

    if (path === "/healthz") return new Response("ok\n");
    if (path === "/favicon.ico") return new Response("", { status: 204 });
    if (path === "/avatar.svg" && method === "GET") {
      const svg = avatarFor(url.searchParams.get("name") || "Risulta");
      if (!svg) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=300" } });
    }
    // Operational counters in Prometheus exposition. Unauthenticated by
    // design like the Bun app: the binary binds loopback, so this is
    // network-restricted. Do not route /metrics through a public proxy.
    if (path === "/metrics" && method === "GET") {
      return new Response(metricsText(loginRateLimitKeys()), {
        headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" },
      });
    }
    if (method === "GET" && (path === "/style.css" || path === "/dashboard.js")) return env.ASSETS.fetch(request);
    if (method === "GET" && (path === "/favicon-light.svg" || path === "/favicon-dark.svg" || path === "/site.webmanifest")) {
      return env.ASSETS.fetch(request);
    }

    // Tracker asset: public, cookieless, same behavior as the Bun app.
    const jsMatch = /^\/js\/([A-Za-z0-9_-]+)\.js$/.exec(path);
    if (jsMatch && method === "GET") {
      const site = siteForKey(env.DB, jsMatch[1]);
      if (!site) return json({ error: "unknown site" }, 404);
      return new Response(trackerFor(jsMatch[1]), { headers: { "content-type": "text/javascript;charset=utf-8" } });
    }

    // Collector: public. Derives the daily salted visitor hash server-side
    // from the runtime-resolved client IP + User-Agent; neither input is
    // stored. Rejections (400/403) count as rejected events; unknown keys
    // (404) are not a site and are not counted, mirroring the Bun app.
    const eventMatch = /^\/api\/event\/([A-Za-z0-9_-]+)$/.exec(path);
    if (eventMatch && method === "POST") {
      const site = siteForKey(env.DB, eventMatch[1]);
      if (!site) return json({ error: "unknown site" }, 404);
      const parsed = parseJson(body);
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
    }

    // Sign-in. Rate-limited per email; JSON callers get codes, forms get the
    // page re-rendered with an error.
    if (path === "/login") {
      if (method === "GET") {
        const existing = await readSession(env.DB, request);
        if (existing) return redirect("/");
        return new Response(loginPage(""), { headers: { "content-type": "text/html;charset=utf-8" } });
      }
      if (method === "POST") {
        if (!sameOriginHost(request)) {
          if (wantsJson) return json({ error: "forbidden" }, 403);
          return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        let email = "";
        let password = "";
        if (wantsJson) {
          const parsed = parseJson(body);
          if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
          email = normalizeEmail(parsed.value.email);
          password = String(parsed.value.password || "");
        } else {
          const form = new URLSearchParams(body);
          email = normalizeEmail(form.get("email"));
          password = String(form.get("password") || "");
        }
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
          // Legacy row (s2$ standalone or Bun scrypt$): upgrade to the
          // current KDF now that the password is proven.
          try {
            env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(password), user.id).run();
          } catch {
            /* keep the legacy hash on failure */
          }
        }
        const session = await createSession(env.DB, user.id);
        const cookie = setSessionCookie(session.token, secure);
        if (wantsJson) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookie } });
        return redirect("/", cookie);
      }
    }

    // Everything below requires a session. API callers get 401 JSON,
    // browsers get the sign-in page via redirect.
    const session = await readSession(env.DB, request);
    const apiRoute = path === "/api" || path.indexOf("/api/") === 0;
    if (!session) {
      if (apiRoute) return json({ error: "sign in required" }, 401);
      return redirect("/login");
    }
    const isAdmin = session.role === "admin";

    if (path === "/logout" && method === "POST") {
      if (!csrfValid(session, csrfValue(request, body))) return wantsJson ? json({ error: "csrf mismatch" }, 403) : redirect("/login");
      await destroySession(env.DB, request);
      const expired = expiredSessionCookie(secure);
      if (wantsJson) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": expired } });
      return redirect("/login", expired);
    }

    if (path === "/api/session" && method === "GET") {
      return json({ id: session.user_id, email: session.email, displayName: session.display_name, role: session.role, csrf: session.csrf });
    }

    if (path === "/" && method === "GET") {
      const sites = listSitesForUser(env.DB, session);
      const now = Math.floor(Date.now() / 1000);
      const overviews = [];
      for (let i = 0; i < sites.length; i++) {
        const summary = siteSummary(env.DB, sites[i].id, now - 7 * 86400, now + 1);
        overviews.push({ id: sites[i].id, name: sites[i].name, domain: sites[i].domain, overview: { visitors: Number(summary.visitors), pageviews: Number(summary.pageviews) } });
      }
      return new Response(homePage(session, overviews), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/sites/new" && method === "GET") {
      if (!isAdmin) return redirect("/");
      const error = url.searchParams.get("error") || "";
      return new Response(newSitePage(session, error), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/account" && method === "GET") {
      const changed = (url.searchParams.get("changed") || "") === "1";
      const profile = url.searchParams.get("profile") || "";
      return new Response(accountPage(session, { changed, profile }),
        { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/api/account/password" && method === "POST") {
      let current = "";
      let next = "";
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        current = String(parsed.value.current || "");
        next = String(parsed.value.password || "");
      } else {
        const form = new URLSearchParams(body);
        current = String(form.get("current") || "");
        next = String(form.get("password") || "");
      }
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      const user = env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(session.user_id).first();
      if (!user || !(await verifyPassword(current, user.password_hash)).ok) return json({ error: "current password is wrong" }, 403);
      if (next.length < 12) return json({ error: "new password needs 12+ characters" }, 400);
      changePassword(env.DB, session, await hashPassword(next));
      if (wantsJson) return json({ ok: true });
      return redirect("/account?changed=1");
    }

    if (path === "/api/account/profile" && method === "POST") {
      let displayName = "";
      let email = "";
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        displayName = String(parsed.value.displayName || parsed.value.display_name || "").trim().slice(0, 80);
        email = normalizeEmail(parsed.value.email);
      } else {
        const form = new URLSearchParams(body);
        displayName = String(form.get("displayName") || form.get("display_name") || "").trim().slice(0, 80);
        email = normalizeEmail(form.get("email"));
      }
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      if (!displayName) {
        if (wantsJson) return json({ error: "display name is required" }, 400);
        return redirect("/account?profile=name-required");
      }
      if (!email.includes("@")) {
        if (wantsJson) return json({ error: "email is invalid" }, 400);
        return redirect("/account?profile=email-invalid");
      }
      try {
        updateProfile(env.DB, session.user_id, displayName, email);
      } catch {
        if (wantsJson) return json({ error: "email already registered" }, 409);
        return redirect("/account?profile=email-registered");
      }
      if (wantsJson) return json({ ok: true });
      return redirect("/account?profile=1");
    }

    if (path === "/api/account/delete" && method === "POST") {
      let confirmation = "";
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        confirmation = String(parsed.value.confirmation || "");
      } else {
        confirmation = String(new URLSearchParams(body).get("confirmation") || "");
      }
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
      const expired = expiredSessionCookie(secure);
      if (wantsJson) return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": expired } });
      return redirect("/login", expired);
    }

    if (path === "/users" && method === "GET") {
      if (!isAdmin) return redirect("/");
      const users = env.DB.prepare(
        "SELECT users.id, users.email, users.display_name, users.role, users.created_at, group_concat(sites.name, ', ') AS sites " +
          "FROM users LEFT JOIN site_users ON site_users.user_id = users.id LEFT JOIN sites ON sites.id = site_users.site_id " +
          "GROUP BY users.id ORDER BY users.created_at, users.id",
      ).all().results;
      const sites = env.DB.prepare("SELECT id, name, domain FROM sites ORDER BY name COLLATE NOCASE").all().results;
      return new Response(usersPage(session, users, sites), { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/api/users" && method === "POST") {
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
        const rawSites = input.siteIds || input.site_ids || [];
        for (let i = 0; i < rawSites.length; i++) siteIds.push(Number(rawSites[i]));
      } else {
        const form = new URLSearchParams(body);
        email = normalizeEmail(form.get("email"));
        displayName = String(form.get("display_name") || "").trim().slice(0, 80);
        password = String(form.get("password") || "");
        role = form.get("role") === "admin" ? "admin" : "viewer";
        const checked = form.getAll("site");
        for (let i = 0; i < checked.length; i++) siteIds.push(Number(checked[i]));
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
    }

    const deleteUserMatch = /^\/api\/users\/(\d+)\/delete$/.exec(path);
    if (deleteUserMatch && method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      const targetId = Number(deleteUserMatch[1]);
      if (targetId === session.user_id) return json({ error: "cannot delete yourself" }, 400);
      const target = env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(targetId).first();
      if (!target) return json({ error: "unknown user" }, 404);
      if (target.role === "admin" && adminCount(env.DB) < 2) {
        return json({ error: "cannot delete the last administrator" }, 400);
      }
      removeUser(env.DB, targetId);
      if (wantsJson) return json({ ok: true });
      return redirect("/users");
    }

    const sitePageMatch = /^\/sites\/(\d+)$/.exec(path);
    if (sitePageMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(sitePageMatch[1]), session);
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
      // Previous-period comparison: the summary for the immediately
      // preceding window of the same length, like the Bun app.
      let comparison = null;
      if (url.searchParams.get("compare") === "1") {
        comparison = siteSummary(env.DB, site.id, range.since - days * 86400, range.since);
      }
      const sites = listSitesForUser(env.DB, session);
      return new Response(sitePage(session, site, sites, analytics, range, days, metric, url.origin, comparison),
        { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    if (path === "/api/sites" && method === "GET") {
      return json(listSitesForUser(env.DB, session));
    }

    if (path === "/api/sites" && method === "POST") {
      if (!isAdmin) return json({ error: "forbidden" }, 403);
      if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
      let name = "";
      let domain = "";
      if (wantsJson) {
        const parsed = parseJson(body);
        if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
        const input = parsed.value;
        name = String(input.name || "").trim().slice(0, 80);
        domain = cleanDomain(input.domain);
      } else {
        const form = new URLSearchParams(body);
        name = String(form.get("name") || "").trim().slice(0, 80);
        domain = cleanDomain(form.get("domain"));
      }
      if (!name || !validDomain(domain)) {
        if (wantsJson) return json({ error: !name ? "name is required" : "domain is invalid" }, 400);
        return redirect("/sites/new?error=" + (!name ? "name-required" : "domain-invalid"));
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
    }

    // Goals per site (writes are admin-only; reads follow site access).
    const goalsMatch = /^\/api\/sites\/(\d+)\/goals$/.exec(path);
    if (goalsMatch) {
      const site = getSiteForUser(env.DB, Number(goalsMatch[1]), session);
      if (!site) return json({ error: "unknown site" }, 404);
      if (method === "GET") {
        return json(env.DB.prepare("SELECT id, name, event_name, path, created_at FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results);
      }
      if (method === "POST") {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
        let name = "";
        let eventName = "";
        let goalPath = "";
        if (wantsJson) {
          const parsed = parseJson(body);
          if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
          const input = parsed.value;
          name = String(input.name || "").trim().slice(0, 80);
          eventName = String(input.eventName || input.event_name || "").trim().slice(0, 64);
          goalPath = String(input.path || "").trim().slice(0, 2048);
        } else {
          const form = new URLSearchParams(body);
          name = String(form.get("name") || "").trim().slice(0, 80);
          eventName = String(form.get("event_name") || "").trim().slice(0, 64);
          goalPath = String(form.get("path") || "").trim().slice(0, 2048);
        }
        if (!name) {
          if (wantsJson) return json({ error: "name is required" }, 400);
          return redirect("/sites/" + site.id + "/settings?error=goal-name-required");
        }
        if (!validEventName(eventName)) {
          if (wantsJson) return json({ error: "event name is invalid" }, 400);
          return redirect("/sites/" + site.id + "/settings?error=goal-event-invalid");
        }
        if (goalPath !== "" && goalPath.charAt(0) !== "/") {
          if (wantsJson) return json({ error: "path must start with /" }, 400);
          return redirect("/sites/" + site.id + "/settings?error=goal-path-invalid");
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
      }
    }

    // Funnels per site: ordered goal sequences with per-step conversions.
    // Writes are admin-only; reads follow site access (via analytics).
    const funnelsMatch = /^\/api\/sites\/(\d+)\/funnels$/.exec(path);
    if (funnelsMatch) {
      const site = getSiteForUser(env.DB, Number(funnelsMatch[1]), session);
      if (!site) return json({ error: "unknown site" }, 404);
      if (method === "GET") {
        return json(listFunnels(env.DB, site.id));
      }
      if (method === "POST") {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        if (!csrfValid(session, csrfValue(request, body))) return json({ error: "csrf mismatch" }, 403);
        let name = "";
        let goalIds = [];
        if (wantsJson) {
          const parsed = parseJson(body);
          if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
          const input = parsed.value;
          name = String(input.name || "").trim().slice(0, 100);
          const rawIds = input.goalIds || input.goal_ids || [];
          for (let i = 0; i < rawIds.length; i++) goalIds.push(Number(rawIds[i]));
        } else {
          const form = new URLSearchParams(body);
          name = String(form.get("name") || "").trim().slice(0, 100);
          const checked = form.getAll("goal");
          for (let i = 0; i < checked.length; i++) goalIds.push(Number(checked[i]));
        }
        const settingsUrl = "/sites/" + site.id + "/settings";
        if (!name) {
          if (wantsJson) return json({ error: "name is required" }, 400);
          return redirect(settingsUrl + "?error=funnel-name-required");
        }
        const siteGoals = env.DB.prepare("SELECT id FROM goals WHERE site_id = ?").bind(site.id).all().results;
        const validIds = {};
        for (let i = 0; i < siteGoals.length; i++) validIds[siteGoals[i].id] = 1;
        const seen = {};
        let stepsOk = goalIds.length >= 2;
        for (let i = 0; i < goalIds.length; i++) {
          if (!validIds[goalIds[i]] || seen[goalIds[i]]) {
            stepsOk = false;
            break;
          }
          seen[goalIds[i]] = 1;
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
      }
    }

    // Website settings: tracker snippet, goal list, funnel management.
    const settingsMatch = /^\/sites\/(\d+)\/settings$/.exec(path);
    if (settingsMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(settingsMatch[1]), session);
      if (!site) {
        return new Response(pageShell("Not found", session, '<main class="shell" id="main"><h1>Unknown site</h1></main>', null, []),
          { status: 404, headers: { "content-type": "text/html;charset=utf-8" } });
      }
      const sites = listSitesForUser(env.DB, session);
      const goals = env.DB.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results;
      const funnels = listFunnels(env.DB, site.id);
      const error = url.searchParams.get("error") || "";
      return new Response(settingsPage(session, site, sites, goals, funnels, error, url.origin),
        { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // Live fragment for htmx polling: the same server-rendered markup as
    // the dashboard's live region, swapped in every few seconds.
    const liveMatch = /^\/sites\/(\d+)\/partials\/live$/.exec(path);
    if (liveMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(liveMatch[1]), session);
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
      return new Response(liveFragment(site, analytics, range, days, metric, comparison),
        { headers: { "content-type": "text/html;charset=utf-8" } });
    }

    // Stats: D1-backed summary with 30-minute visit boundary, configured
    // conversion goals, and an explicit or period-based range. Per-day rows
    // carry their own distinct counts; multi-day totals are visitor-days
    // only in the per-day breakdown, never summed.
    const statsMatch = /^\/api\/sites\/(\d+)\/stats$/.exec(path);
    if (statsMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(statsMatch[1]), session);
      if (!site) return json({ error: "unknown site" }, 404);
      const now = Math.floor(Date.now() / 1000);
      const range = parseRange(url.searchParams, now);
      if (range.error) return json({ error: range.error }, 400);
      const analytics = siteAnalytics(env.DB, site, range.since, range.until);
      return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...analytics });
    }

    // Bounded report with exact-match filters, sortable and paginated, as
    // JSON or CSV download. Generated synchronously; no job queue exists.
    const reportMatch = /^\/api\/sites\/(\d+)\/report$/.exec(path);
    if (reportMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(reportMatch[1]), session);
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
    }

    // Full HTML report: dimension tabs, exact-match filters, sortable table,
    // pagination, CSV download. Same bounded query as the JSON report.
    const htmlReportMatch = /^\/sites\/(\d+)\/reports$/.exec(path);
    if (htmlReportMatch && method === "GET") {
      const site = getSiteForUser(env.DB, Number(htmlReportMatch[1]), session);
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
    }

    // Online backup of the D1 database: an integrity-checked single-file
    // snapshot in backups/, no downtime, no WAL sidecars. Admin only.
    // The response carries a manifest (row counts per table) so a copied
    // snapshot can be audited before a restore. Copy the file off the box;
    // restore by putting it back at d1/DB.sqlite on a stopped binary.
    if (path === "/api/backup" && method === "POST") {
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
    }

    // Embedded static assets for signed-in pages. The assets directory is
    // the URL root; unknown API routes stay JSON.
    if (apiRoute) return json({ error: "not found", path }, 404);
    if (method === "GET") return env.ASSETS.fetch(request);

    return json({ error: "not found", path }, 404);
  }

async function routeRequest(request) {
  const startedAt = Date.now();
  let response;
  try {
    response = await routeInner(request);
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
  // The runtime resolves a returned promise directly; no .then() chaining
  // on top of it (that shape hangs). Logging and error counting live
  // inside routeRequest so this stays a direct return.
  fetch(request) {
    return routeRequest(request);
  },
};
