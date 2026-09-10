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
  ensureReady,
  getSiteForUser,
  listSitesForUser,
  reportCsv,
  siteAnalytics,
  siteByKey,
  siteForKey,
  siteReport,
  siteSummary,
  visitorId,
} from "./store.js";
import { escapeHtml } from "./util.js";
import {
  accountPage,
  homePage,
  liveFragment,
  loginPage,
  newSitePage,
  pageShell,
  sitePage,
  trackerFor,
  usersPage,
} from "./views.js";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}

function parseJson(body) {
  try {
    return { ok: true, value: JSON.parse(body || "{}") };
  } catch {
    return { ok: false, value: {} };
  }
}

function redirect(to, cookie) {
  const headers = { location: to };
  if (cookie) headers["set-cookie"] = cookie;
  return new Response("", { status: 302, headers });
}

export default {
  fetch(request) {
    ensureReady(env.DB);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const secure = url.protocol === "https:";
    const body = method === "POST" || method === "PUT" ? request.body || "" : "";
    const ctype = request.headers.get("content-type") || "";
    const wantsJson = ctype.indexOf("application/json") !== -1;

    if (path === "/healthz") return new Response("ok\n");
    if (path === "/favicon.ico") return new Response("", { status: 204 });
    if (method === "GET" && (path === "/style.css" || path === "/dashboard.js")) return env.ASSETS.fetch(request);

    // Tracker asset: public, cookieless, same behavior as the Bun app.
    const jsMatch = /^\/js\/([A-Za-z0-9_-]+)\.js$/.exec(path);
    if (jsMatch && method === "GET") {
      const site = siteForKey(env.DB, jsMatch[1]);
      if (!site) return json({ error: "unknown site" }, 404);
      return new Response(trackerFor(jsMatch[1]), { headers: { "content-type": "text/javascript;charset=utf-8" } });
    }

    // Collector: public. Derives the daily salted visitor hash server-side
    // from proxy-provided IP + User-Agent; neither input is stored.
    const eventMatch = /^\/api\/event\/([A-Za-z0-9_-]+)$/.exec(path);
    if (eventMatch && method === "POST") {
      const site = siteForKey(env.DB, eventMatch[1]);
      if (!site) return json({ error: "unknown site" }, 404);
      const parsed = parseJson(body);
      if (!parsed.ok) return json({ error: "body must be JSON" }, 400);
      const input = parsed.value;
      const name = String(input.name || "");
      if (!validEventName(name)) return json({ error: "event name is invalid" }, 400);
      const value = validValue(input.value === undefined ? null : input.value);
      if (value === false) return json({ error: "value is out of range" }, 400);
      const domain = cleanDomain(input.domain);
      if (domain !== site.domain) return json({ error: "domain mismatch" }, 403);
      const parts = splitPathAndAttribution(input.path);
      if (parts.path.charAt(0) !== "/") return json({ error: "path must start with /" }, 400);
      const ts = Math.floor(Date.now() / 1000);
      env.DB.prepare(
        "INSERT INTO events (site_id, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          site.id, ts, name, parts.path, referrerHost(input.referrer),
          visitorId(env.DB, site, request),
          parts.source, parts.medium, parts.campaign, parts.content, parts.term, value,
        )
        .run();
      return json({ ok: true }, 202);
    }

    // Sign-in. Rate-limited per email; JSON callers get codes, forms get the
    // page re-rendered with an error.
    if (path === "/login") {
      if (method === "GET") {
        const existing = readSession(env.DB, request);
        if (existing) return redirect("/");
        return new Response(loginPage(""), { headers: { "content-type": "text/html;charset=utf-8" } });
      }
      if (method === "POST") {
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
          if (wantsJson) return json({ error: "too many attempts, try later" }, 429);
          return new Response(loginPage("Too many attempts, try again later."), { headers: { "content-type": "text/html;charset=utf-8" } });
        }
        const user = env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
        if (!user || !verifyPassword(password, user.password_hash)) {
          recordLoginFailure(email);
          if (wantsJson) return json({ error: "invalid email or password" }, 401);
          return new Response(loginPage("Invalid email or password."), { headers: { "content-type": "text/html;charset=utf-8" } });
        }
        clearLoginFailures(email);
        const session = createSession(env.DB, user.id);
        const cookie = setSessionCookie(session.token, secure);
        if (wantsJson) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": cookie } });
        return redirect("/", cookie);
      }
    }

    // Everything below requires a session. API callers get 401 JSON,
    // browsers get the sign-in page via redirect.
    const session = readSession(env.DB, request);
    const apiRoute = path === "/api" || path.indexOf("/api/") === 0;
    if (!session) {
      if (apiRoute) return json({ error: "sign in required" }, 401);
      return redirect("/login");
    }
    const isAdmin = session.role === "admin";

    if (path === "/logout" && method === "POST") {
      if (!csrfValid(session, csrfValue(request, body))) return wantsJson ? json({ error: "csrf mismatch" }, 403) : redirect("/login");
      destroySession(env.DB, request);
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
      return new Response(accountPage(session, changed), { headers: { "content-type": "text/html;charset=utf-8" } });
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
      if (!user || !verifyPassword(current, user.password_hash)) return json({ error: "current password is wrong" }, 403);
      if (next.length < 12) return json({ error: "new password needs 12+ characters" }, 400);
      changePassword(env.DB, session, hashPassword(next));
      if (wantsJson) return json({ ok: true });
      return redirect("/account?changed=1");
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
        userId = createUser(env.DB, email, password, role, siteIds, displayName);
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
      if (target.role === "admin" && Number(env.DB.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin'").first().n) < 2) {
        return json({ error: "cannot delete the last administrator" }, 400);
      }
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId).run();
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
      const goalsList = env.DB.prepare("SELECT id, name, event_name, path FROM goals WHERE site_id = ? ORDER BY id").bind(site.id).all().results;
      analytics.goalsList = goalsList;
      const sites = listSitesForUser(env.DB, session);
      return new Response(sitePage(session, site, sites, analytics, range, days, metric, url.origin),
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
        if (!name) return json({ error: "name is required" }, 400);
        if (!validEventName(eventName)) return json({ error: "event name is invalid" }, 400);
        if (goalPath !== "" && goalPath.charAt(0) !== "/") return json({ error: "path must start with /" }, 400);
        try {
          env.DB.prepare("INSERT INTO goals (site_id, name, event_name, path, created_at) VALUES (?, ?, ?, ?, ?)")
            .bind(site.id, name, eventName, goalPath, Math.floor(Date.now() / 1000))
            .run();
        } catch {
          return json({ error: "goal name already exists for this site" }, 409);
        }
        if (wantsJson) return json({ ok: true, name, eventName, path: goalPath }, 201);
        return redirect("/sites/" + site.id);
      }
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
      return new Response(liveFragment(site, analytics, range, days, metric),
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
      const q = url.searchParams;
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
      const report = siteReport(
        env.DB, site.id, range.since, range.until,
        String(q.get("dimension") || "path"), filters,
        q.get("limit"), q.get("offset"), String(q.get("sort") || "visitors"),
      );
      if (String(q.get("format") || "") === "csv") {
        return new Response(reportCsv(report), {
          headers: {
            "content-type": "text/csv;charset=utf-8",
            "content-disposition": 'attachment; filename="site-' + site.id + "-" + report.dimension + '.csv"',
          },
        });
      }
      return json({ site: { id: site.id, name: site.name, domain: site.domain }, range: range.label, ...report });
    }

    // Embedded static assets for signed-in pages. The assets directory is
    // the URL root; unknown API routes stay JSON.
    if (apiRoute) return json({ error: "not found", path }, 404);
    if (method === "GET") return env.ASSETS.fetch(request);

    return json({ error: "not found", path }, 404);
  },
};
