// Risulta - privacy-friendly multi-site analytics in one Bun-compiled binary.
// Contract: HTTP on $PORT, durable state in $DATA_DIR, clean SIGTERM.
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  clearLoginFailures, createSession, csrfValid, destroySession, expiredCookies,
  hashPassword, loginAllowed, normalizeEmail, readSession, recordLoginFailure,
  sessionCookie, verifyPassword,
} from "./lib/auth.js";
import { RisultaDatabase } from "./lib/db.js";
import { trackerFor } from "./lib/tracker.js";
import { dashboardPage, loginPage, newSitePage, settingsPage, sitesPage, usersPage } from "./lib/views.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || ".";
const TRUST_PROXY = process.env.RISULTA_TRUST_PROXY === "1";
mkdirSync(DATA_DIR, { recursive: true });
const database = new RisultaDatabase(DATA_DIR);

const adminEmail = normalizeEmail(process.env.RISULTA_ADMIN_EMAIL);
const adminPassword = process.env.RISULTA_ADMIN_PASSWORD || "";
if (!database.userCount() && adminEmail && adminPassword.length >= 12) {
  database.createUser(adminEmail, hashPassword(adminPassword), "admin");
  console.log(`created administrator ${adminEmail}`);
} else if (!database.userCount() && (adminEmail || adminPassword)) {
  console.error("administrator bootstrap skipped: set a valid email and a password of at least 12 characters");
}

const cleanHost = (value) => String(value || "localhost").split(",")[0].trim().slice(0, 255);
const cleanDomain = (value) => String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/:\d+$/, "").replace(/\.$/, "").slice(0, 253);
const validDomain = (value) => value === "localhost" || (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value));
const cleanPath = (value) => {
  const path = String(value || "").trim();
  return path.startsWith("/") ? path.slice(0, 512) : `/${path}`.slice(0, 512);
};
const dayKey = (timestamp = Date.now()) => new Date(timestamp).toISOString().slice(0, 10);
const periodStart = (days) => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (days - 1));
  return Math.floor(date.getTime() / 1000);
};

function requestBase(req) {
  if (process.env.RISULTA_BASE_URL) return process.env.RISULTA_BASE_URL.replace(/\/$/, "");
  const forwardedProto = TRUST_PROXY ? String(req.headers["x-forwarded-proto"] || "").split(",")[0] : "";
  return `${forwardedProto === "https" ? "https" : "http"}://${cleanHost(req.headers.host)}`;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers["x-forwarded-for"];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]);
    if (ip) return ip.trim();
  }
  return req.socket.remoteAddress || "";
}

function visitorHash(store, req, timestamp) {
  return createHash("sha256").update(store.salt(dayKey(timestamp))).update(clientIp(req))
    .update(String(req.headers["user-agent"] || "")).digest("hex").slice(0, 24);
}

const securityHeaders = {
  "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
const htmlHeaders = {
  ...securityHeaders, "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function send(res, status, body = "", headers = {}) {
  res.writeHead(status, { ...securityHeaders, ...headers, "content-length": Buffer.byteLength(body) }).end(body);
}
function html(res, status, body, headers = {}) { send(res, status, body, { ...htmlHeaders, ...headers }); }
function redirect(res, location, headers = {}) { send(res, 303, "", { ...headers, location, "cache-control": "no-store" }); }

async function formBody(req, max = 16 * 1024) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > max) throw new Error("payload too large"); }
  return new URLSearchParams(body);
}
async function jsonBody(req, max = 4096) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > max) throw new Error("payload too large"); }
  return JSON.parse(body);
}
function analyticsEvent(payload) {
  if (Object.prototype.toString.call(payload?.path) !== "[object String]") throw new Error("invalid event path");
  return {
    name: String(payload?.name || ""),
    path: payload.path,
    domain: String(payload?.domain || ""),
    referrer: String(payload?.referrer || ""),
  };
}
function sameOrigin(req, baseUrl) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(baseUrl).origin; } catch { return false; }
}
function requireAdmin(user, res) {
  if (user.role === "admin") return true;
  send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  return false;
}

const server = http.createServer(async (req, res) => {
  const baseUrl = requestBase(req);
  const url = new URL(req.url || "/", baseUrl);
  const trackerMatch = url.pathname.match(/^\/js\/([A-Za-z0-9_-]+)\.js$/);
  const eventMatch = url.pathname.match(/^\/api\/event\/([A-Za-z0-9_-]+)$/);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      send(res, 200, "ok\n", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); return;
    }
    if (req.method === "OPTIONS" && eventMatch) {
      send(res, 204, "", { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" }); return;
    }
    if (req.method === "GET" && trackerMatch) {
      const site = database.getSiteByKey(trackerMatch[1]);
      if (!site) { send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" }); return; }
      const tracker = trackerFor(site.public_key);
      send(res, 200, tracker, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400, immutable", "access-control-allow-origin": "*" }); return;
    }
    if (req.method === "POST" && eventMatch) {
      const site = database.getSiteByKey(eventMatch[1]);
      if (!site) { send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" }); return; }
      try {
        const event = analyticsEvent(await jsonBody(req));
        if (event.name !== "pageview" || cleanDomain(event.domain) !== cleanDomain(site.domain)) throw new Error("invalid event");
        const now = Date.now();
        const store = database.siteStore(site);
        store.insert({ ts: Math.floor(now / 1000), name: "pageview", path: cleanPath(event.path), referrer: String(event.referrer || "").slice(0, 512), visitor: visitorHash(store, req, now) });
        send(res, 202, "", { "access-control-allow-origin": "*", "cache-control": "no-store" });
      } catch {
        send(res, 400, "Invalid analytics event", { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/login") {
      const session = readSession(database, req);
      if (session) { redirect(res, "/"); return; }
      html(res, 200, loginPage({ hasUsers: database.userCount() > 0 })); return;
    }
    if (req.method === "POST" && url.pathname === "/login") {
      if (!sameOrigin(req, baseUrl)) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      const form = await formBody(req);
      const email = normalizeEmail(form.get("email"));
      const password = String(form.get("password") || "");
      const rateKey = `${clientIp(req)}:${email}`;
      const user = database.findUserByEmail(email);
      if (!loginAllowed(rateKey) || !user || !verifyPassword(password, user.password_hash)) {
        recordLoginFailure(rateKey);
        html(res, 401, loginPage({ error: "Email or password is incorrect.", hasUsers: database.userCount() > 0, email })); return;
      }
      clearLoginFailures(rateKey);
      const session = createSession(database, user.id);
      redirect(res, "/", { "set-cookie": sessionCookie(session.token, baseUrl.startsWith("https://")) }); return;
    }

    const user = readSession(database, req);
    if (!user) { redirect(res, "/login"); return; }
    if (req.method === "POST" && url.pathname === "/logout") {
      const form = await formBody(req);
      if (!sameOrigin(req, baseUrl) || !csrfValid(user, form.get("csrf"))) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      destroySession(database, req); redirect(res, "/login", { "set-cookie": expiredCookies() }); return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      const sites = database.listSitesForUser(user);
      const requestedSite = Number(url.searchParams.get("site"));
      if (Number.isInteger(requestedSite) && sites.some((site) => site.id === requestedSite)) { redirect(res, `/sites/${requestedSite}`); return; }
      const overviewSince = periodStart(7);
      const sitesWithOverview = sites.map((site) => ({ ...site, overview: database.siteStore(site).analytics(overviewSince).summary }));
      html(res, 200, sitesPage({ user, csrf: user.csrf, sites: sitesWithOverview })); return;
    }
    if (req.method === "GET" && url.pathname === "/admin/sites/new") {
      if (!requireAdmin(user, res)) return;
      html(res, 200, newSitePage({ user, csrf: user.csrf })); return;
    }
    if (req.method === "POST" && url.pathname === "/admin/sites") {
      if (!requireAdmin(user, res)) return;
      const form = await formBody(req);
      if (!sameOrigin(req, baseUrl) || !csrfValid(user, form.get("csrf"))) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      const name = String(form.get("name") || "").trim().slice(0, 100);
      const domain = cleanDomain(form.get("domain"));
      if (!name || !validDomain(domain)) {
        html(res, 400, newSitePage({ user, csrf: user.csrf, error: "Enter a name and a valid domain.", values: { name, domain } })); return;
      }
      try { const site = database.createSite(name, domain); redirect(res, `/sites/${site.id}`); }
      catch { html(res, 409, newSitePage({ user, csrf: user.csrf, error: "That domain is already configured.", values: { name, domain } })); }
      return;
    }
    if (req.method === "GET" && url.pathname === "/admin/users") {
      if (!requireAdmin(user, res)) return;
      html(res, 200, usersPage({ user, csrf: user.csrf, users: database.listUsers(), sites: database.listSitesForUser(user) })); return;
    }
    if (req.method === "POST" && url.pathname === "/admin/users") {
      if (!requireAdmin(user, res)) return;
      const form = await formBody(req);
      if (!sameOrigin(req, baseUrl) || !csrfValid(user, form.get("csrf"))) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      const email = normalizeEmail(form.get("email"));
      const password = String(form.get("password") || "");
      const role = form.get("role") === "admin" ? "admin" : "viewer";
      const siteIds = form.getAll("site").map(Number).filter(Number.isInteger);
      let error = "";
      if (!email.includes("@")) error = "Enter a valid email address.";
      else if (password.length < 12) error = "The password must have at least 12 characters.";
      if (!error) { try { database.createUser(email, hashPassword(password), role, siteIds); } catch { error = "A user with that email already exists."; } }
      if (error) html(res, 400, usersPage({ user, csrf: user.csrf, users: database.listUsers(), sites: database.listSitesForUser(user), error }));
      else redirect(res, "/admin/users");
      return;
    }
    const settingsMatch = url.pathname.match(/^\/sites\/(\d+)\/settings$/);
    if (req.method === "GET" && settingsMatch) {
      const site = database.getSiteForUser(Number(settingsMatch[1]), user);
      if (!site) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); return; }
      html(res, 200, settingsPage({ user, csrf: user.csrf, site, sites: database.listSitesForUser(user), baseUrl })); return;
    }
    const siteMatch = url.pathname.match(/^\/sites\/(\d+)$/);
    if (req.method === "GET" && siteMatch) {
      const site = database.getSiteForUser(Number(siteMatch[1]), user);
      if (!site) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); return; }
      const requested = Number(url.searchParams.get("period"));
      const days = [1, 7, 30].includes(requested) ? requested : 7;
      const since = periodStart(days);
      html(res, 200, dashboardPage({ user, csrf: user.csrf, site, sites: database.listSitesForUser(user), analytics: database.siteStore(site).analytics(since), days, baseUrl })); return;
    }
    send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, "Internal server error", { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`risulta on ${HOST}:${PORT}, data in ${DATA_DIR}`));
process.on("SIGTERM", () => {
  server.close(() => { database.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 3000).unref();
});
