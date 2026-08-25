// Risulta - privacy-friendly multi-site analytics in one Bun-compiled binary.
// Contract: HTTP on $PORT, durable state in $DATA_DIR, clean SIGTERM.
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { blobatar } from "blobatar/blob";
import {
  clearLoginFailures, createSession, csrfValid, destroySession, expiredCookies,
  hashPassword, loginAllowed, normalizeEmail, readSession, recordLoginFailure,
  sessionCookie, verifyPassword,
} from "./lib/auth.js";
import { RisultaDatabase } from "./lib/db.js";
import { trackerFor } from "./lib/tracker.js";
import { VERSION } from "./lib/version.js";
import { accountPage, dashboardPage, loginPage, newSitePage, settingsPage, sitesPage, usersPage } from "./lib/views.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || ".";
const trustedProxyConfig = process.env.RISULTA_TRUST_PROXY_CIDRS
  || (process.env.RISULTA_TRUST_PROXY === "1" ? "127.0.0.1/32,::1/128" : "");
if (process.argv[2] === "--version" || process.argv[2] === "version") {
  console.log(VERSION);
  process.exit(0);
}
const configuredIngestLimit = Number(process.env.RISULTA_INGEST_RATE_LIMIT || 240);
const INGEST_RATE_LIMIT = Number.isFinite(configuredIngestLimit) && configuredIngestLimit >= 1
  ? Math.floor(configuredIngestLimit) : 240;
const INGEST_RATE_WINDOW = 60 * 1000;
const MAX_INGEST_RATE_KEYS = 10_000;
const ingestRates = new Map();
let nextIngestRateSweep = 0;
mkdirSync(DATA_DIR, { recursive: true });
const database = new RisultaDatabase(DATA_DIR);

if (process.argv[2] === "backup") {
  const destination = process.argv[3];
  if (!destination || process.argv[4]) {
    console.error("Usage: risulta backup <destination-directory>");
    database.close();
    process.exit(1);
  }
  try {
    const snapshot = await database.snapshot(destination);
    console.log(`backup created at ${snapshot}`);
    database.close();
    process.exit(0);
  } catch (error) {
    console.error(`backup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    database.close();
    process.exit(1);
  }
}

const adminEmail = normalizeEmail(process.env.RISULTA_ADMIN_EMAIL);
const adminPassword = process.env.RISULTA_ADMIN_PASSWORD || "";
const adminDisplayName = String(process.env.RISULTA_ADMIN_DISPLAY_NAME || "").trim().slice(0, 80);
if (!database.userCount() && adminEmail && adminPassword.length >= 12) {
  database.createUser(adminEmail, hashPassword(adminPassword), "admin", [], adminDisplayName);
  console.log(`created administrator ${adminEmail}`);
} else if (!database.userCount() && (adminEmail || adminPassword)) {
  console.error("administrator bootstrap skipped: set a valid email and a password of at least 12 characters");
}

const cleanHost = (value) => String(value || "localhost").split(",")[0].trim().slice(0, 255);
const cleanDomain = (value) => String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/:\d+$/, "").replace(/\.$/, "").slice(0, 253);
const validDomain = (value) => value === "localhost" || (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value));
const cleanIp = (value) => {
  const ip = String(value || "").trim();
  const mappedIpv4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  return isIP(mappedIpv4 || ip) ? mappedIpv4 || ip : "";
};
const ipValue = (ip) => {
  if (isIP(ip) === 4) return ip.split(".").reduce((value, part) => value << 8n | BigInt(Number(part)), 0n);
  const sections = ip.includes("::") ? ip.split("::") : [ip, ""];
  const left = sections[0] ? sections[0].split(":") : [];
  const right = sections[1] ? sections[1].split(":") : [];
  const ipv4 = right.at(-1)?.includes(".") ? right.pop().split(".").flatMap((part, index, parts) => index % 2 ? [] : [((Number(part) << 8) + Number(parts[index + 1])).toString(16)]) : [];
  const values = [...left, ...Array(8 - left.length - right.length - ipv4.length).fill("0"), ...right, ...ipv4];
  return values.reduce((value, part) => value << 16n | BigInt(`0x${part}`), 0n);
};
function trustedProxyCidrs(value) {
  if (!value) return [];
  return value.split(",").map((entry) => {
    const [address, prefixValue, ...rest] = entry.trim().split("/");
    const family = isIP(address);
    const bits = family === 4 ? 32 : 128;
    const prefix = prefixValue === undefined ? bits : Number(prefixValue);
    if (rest.length || !family || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new Error("RISULTA_TRUST_PROXY_CIDRS must contain valid IPv4 or IPv6 CIDRs");
    const mask = prefix === 0 ? 0n : (1n << BigInt(bits)) - (1n << BigInt(bits - prefix));
    return { family, mask, network: ipValue(address) & mask };
  });
}
const TRUSTED_PROXY_CIDRS = trustedProxyCidrs(trustedProxyConfig);
const trustedProxy = (ip) => {
  const family = isIP(ip);
  if (!family) return false;
  const value = ipValue(ip);
  return TRUSTED_PROXY_CIDRS.some((cidr) => cidr.family === family && (value & cidr.mask) === cidr.network);
};
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
  const forwardedProto = trustedProxy(cleanIp(req.socket.remoteAddress)) ? String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() : "";
  return `${forwardedProto === "https" ? "https" : "http"}://${cleanHost(req.headers.host)}`;
}

function clientIp(req) {
  const remote = cleanIp(req.socket.remoteAddress);
  if (!trustedProxy(remote)) return remote;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map(cleanIp).filter(Boolean);
  for (let index = forwarded.length - 1; index >= 0; index -= 1) if (!trustedProxy(forwarded[index])) return forwarded[index];
  return forwarded[0] || remote;
}

function ingestAllowed(ip, now = Date.now()) {
  if (now >= nextIngestRateSweep) {
    for (const [key, state] of ingestRates) if (state.resetAt <= now) ingestRates.delete(key);
    nextIngestRateSweep = now + INGEST_RATE_WINDOW;
  }
  let state = ingestRates.get(ip);
  if (!state || state.resetAt <= now) {
    if (ingestRates.size >= MAX_INGEST_RATE_KEYS) return { allowed: false, retryAfter: 60 };
    state = { count: 0, resetAt: now + INGEST_RATE_WINDOW };
    ingestRates.set(ip, state);
  }
  state.count += 1;
  return { allowed: state.count <= INGEST_RATE_LIMIT, retryAfter: Math.max(1, Math.ceil((state.resetAt - now) / 1000)) };
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
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    if (req.method === "GET" && url.pathname === "/avatar.svg") {
      const seed = createHash("sha256").update(String(url.searchParams.get("name") || "Risulta").slice(0, 80)).digest("hex");
      send(res, 200, blobatar(seed, { background: "squircle" }), { "content-type": "image/svg+xml", "cache-control": "public, max-age=300" }); return;
    }
    if (req.method === "GET" && ["/favicon-light.svg", "/favicon-dark.svg"].includes(url.pathname)) {
      const dark = url.pathname === "/favicon-dark.svg";
      const background = dark ? "#000000" : "#ffffff";
      const foreground = dark ? "#ededed" : "#171717";
      const border = dark ? "#2e2e2e" : "#eaeaea";
      send(res, 200, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="8" fill="${background}" stroke="${border}" stroke-width="2"/><path fill="${foreground}" d="M8 23h3V16H8zm6 0h3V11h-3zm6 0h3V7h-3z"/></svg>`, { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable" }); return;
    }
    if (req.method === "GET" && url.pathname === "/site.webmanifest") {
      send(res, 200, JSON.stringify({ name: "Risulta", short_name: "Risulta", icons: [{ src: "/favicon-light.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }], theme_color: "#171717", background_color: "#ffffff", display: "standalone" }), { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" }); return;
    }
    if (req.method === "GET" && url.pathname === "/ui.js") {
      send(res, 200, `document.addEventListener("DOMContentLoaded",()=>{const toast=document.createElement("div");toast.className="toast";toast.role="status";toast.ariaLive="polite";let timeout;const notify=message=>{toast.textContent=message;document.body.append(toast);clearTimeout(timeout);timeout=setTimeout(()=>toast.remove(),3000)};const role=document.querySelector("#role"),assign=document.querySelector("#viewer-websites"),sync=()=>{if(!role||!assign)return;const viewer=role.value==="viewer";assign.hidden=!viewer;assign.querySelectorAll("input").forEach(input=>input.disabled=!viewer)};role?.addEventListener("change",sync);sync();const name=document.querySelector("#display-name"),preview=document.querySelector("[data-avatar-preview]");name?.addEventListener("input",()=>{if(preview)preview.src="/avatar.svg?name="+encodeURIComponent(name.value||"Risulta")});document.querySelectorAll("[data-copy-code]").forEach(button=>{const place=()=>{const toggle=document.querySelector(".snippet-toggle"),snippet=document.querySelector(toggle?.checked?"#minimal-snippet":"#formatted-snippet");if(snippet){button.classList.add("snippet-copy");snippet.append(button)}};place();document.querySelector(".snippet-toggle")?.addEventListener("change",place);button.addEventListener("click",async()=>{const snippet=button.parentElement;try{await navigator.clipboard.writeText(snippet.textContent.replace(button.textContent,""));notify("Code copied.")}catch{notify("Copy failed. Select the code and copy it manually.")}})});const chart=document.querySelector(".chart"),guide=chart?.querySelector(".chart-guide"),tooltip=chart?.querySelector(".chart-tooltip"),points=[...(chart?.querySelectorAll(".chart-point")||[])];const activate=point=>{points.forEach(item=>item.classList.toggle("is-active",item===point));if(guide&&tooltip&&point){const x=point.getAttribute("cx");guide.setAttribute("x1",x);guide.setAttribute("x2",x);guide.hidden=false;tooltip.setAttribute("x",x);tooltip.textContent=point.dataset.value;tooltip.hidden=false}};chart?.addEventListener("pointermove",event=>{const box=chart.getBoundingClientRect(),x=(event.clientX-box.left)/box.width*960;activate(points.reduce((nearest,point)=>Math.abs(Number(point.getAttribute("cx"))-x)<Math.abs(Number(nearest.getAttribute("cx"))-x)?point:nearest,points[0]))});chart?.addEventListener("focusin",event=>{const point=event.target.closest(".chart-point");if(point)activate(point)});chart?.addEventListener("pointerleave",()=>{points.forEach(item=>item.classList.remove("is-active"));if(guide)guide.hidden=true;if(tooltip)tooltip.hidden=true});});`, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" }); return;
    }
    if (req.method === "GET" && url.pathname === "/ui.js") {
      send(res, 200, `document.addEventListener("DOMContentLoaded",()=>{const role=document.querySelector("#role"),assign=document.querySelector("#viewer-websites");const sync=()=>{if(!role||!assign)return;const viewer=role.value==="viewer";assign.hidden=!viewer;assign.querySelectorAll("input").forEach(input=>input.disabled=!viewer)};role?.addEventListener("change",sync);sync();const name=document.querySelector("#display-name"),preview=document.querySelector("[data-avatar-preview]");name?.addEventListener("input",()=>{preview.src="/avatar.svg?name="+encodeURIComponent(name.value||"Risulta")});document.querySelectorAll("[data-copy-code]").forEach(button=>button.addEventListener("click",async()=>{const toggle=document.querySelector(".snippet-toggle"),snippet=document.querySelector(toggle?.checked?"#minimal-snippet":"#formatted-snippet"),status=document.querySelector("#copy-status");if(!snippet||!status)return;try{await navigator.clipboard.writeText(snippet.textContent);status.textContent="Code copied."}catch{status.textContent="Copy failed. Select the code and copy it manually."}}));const chart=document.querySelector(".chart"),guide=chart?.querySelector(".chart-guide"),tooltip=chart?.querySelector(".chart-tooltip"),points=[...(chart?.querySelectorAll(".chart-point")||[])];const activate=point=>{points.forEach(item=>item.classList.toggle("is-active",item===point));if(guide&&tooltip&&point){const x=point.getAttribute("cx");guide.setAttribute("x1",x);guide.setAttribute("x2",x);guide.hidden=false;tooltip.setAttribute("x",x);tooltip.textContent=point.dataset.value;tooltip.hidden=false}};chart?.addEventListener("pointermove",event=>{const box=chart.getBoundingClientRect(),x=(event.clientX-box.left)/box.width*960;activate(points.reduce((nearest,point)=>Math.abs(Number(point.getAttribute("cx"))-x)<Math.abs(Number(nearest.getAttribute("cx"))-x)?point:nearest,points[0]))});chart?.addEventListener("focusin",event=>{const point=event.target.closest(".chart-point");if(point)activate(point)});chart?.addEventListener("pointerleave",()=>{points.forEach(item=>item.classList.remove("is-active"));if(guide)guide.hidden=true;if(tooltip)tooltip.hidden=true});});`, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" }); return;
    }
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
        const rate = ingestAllowed(clientIp(req));
        if (!rate.allowed) {
          send(res, 429, "Too many analytics events. Try again shortly.", {
            "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store", "retry-after": String(rate.retryAfter),
          });
          return;
        }
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
    if (req.method === "GET" && url.pathname === "/account") {
      html(res, 200, accountPage({ user, csrf: user.csrf })); return;
    }
    if (req.method === "POST" && url.pathname === "/account/password") {
      const form = await formBody(req);
      if (!sameOrigin(req, baseUrl) || !csrfValid(user, form.get("csrf"))) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      const currentPassword = String(form.get("currentPassword") || "");
      const newPassword = String(form.get("newPassword") || "");
      const confirmPassword = String(form.get("confirmPassword") || "");
      let error = "";
      if (!verifyPassword(currentPassword, database.findUserById(user.user_id).password_hash)) error = "Enter your current password correctly.";
      else if (newPassword.length < 12) error = "Choose a new password with at least 12 characters.";
      else if (newPassword !== confirmPassword) error = "Enter the same new password in both fields.";
      if (error) { html(res, 400, accountPage({ user, csrf: user.csrf, error })); return; }
      database.changePassword(user.user_id, hashPassword(newPassword), user.token_hash);
      html(res, 200, accountPage({ user, csrf: user.csrf, success: "Password changed. Your other active sessions have been signed out." })); return;
    }
    if (req.method === "POST" && url.pathname === "/account/profile") {
      const form = await formBody(req);
      if (!sameOrigin(req, baseUrl) || !csrfValid(user, form.get("csrf"))) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      const displayName = String(form.get("displayName") || "").trim().slice(0, 80);
      const email = normalizeEmail(form.get("email"));
      let error = "";
      if (!displayName) error = "Enter your display name.";
      else if (!email.includes("@")) error = "Enter a valid email address.";
      if (error) { html(res, 400, accountPage({ user, csrf: user.csrf, profileError: error })); return; }
      try { database.updateProfile(user.user_id, displayName, email); }
      catch { html(res, 409, accountPage({ user, csrf: user.csrf, profileError: "That email address is already in use." })); return; }
      html(res, 200, accountPage({ user: { ...user, display_name: displayName, email }, csrf: user.csrf, profileSuccess: "Profile updated." })); return;
    }
    if (req.method === "POST" && url.pathname === "/account/delete") {
      const form = await formBody(req);
      if (!sameOrigin(req, baseUrl) || !csrfValid(user, form.get("csrf"))) { send(res, 403, "Forbidden", { "content-type": "text/plain; charset=utf-8" }); return; }
      if (form.get("confirmation") !== "DELETE") { html(res, 400, accountPage({ user, csrf: user.csrf, deleteError: "Type DELETE to confirm account deletion." })); return; }
      if (!database.deleteUser(user.user_id)) { html(res, 400, accountPage({ user, csrf: user.csrf, deleteError: "Add another administrator before deleting the last administrator account." })); return; }
      redirect(res, "/login", { "set-cookie": expiredCookies() }); return;
    }
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
