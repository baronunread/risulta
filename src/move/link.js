// Link: how a self-hosted instance and a risulta.dev org trust each other.
//
// Connect is an OAuth 2.0 authorization code flow with PKCE, mediated by the
// admin's browser. Nothing is pasted and nothing moves: the result is a link
// (an id and a 256-bit secret) bound to ONE org and ONE instance origin.
//
// After that every link request is SIGNED, never a bearer secret on the wire:
//   Authorization: Risulta-Link id=<link_id>, ts=<unix>, sig=<hex>
//   sig = HMAC-SHA-256(secret, method \n path?query \n ts \n sha256(body))
// A request outside the five minute window, from an unknown or revoked link, or
// whose signature does not match is answered exactly like a missing route.
import { randomHex, bytesToHex } from "../auth.js";
import { utf8Bytes } from "../util.js";
import { ensureSchema, tableExists } from "./schema.js";

export const SKEW_SECONDS = 300;
export const CODE_SECONDS = 300;
export const STATE_SECONDS = 600;
export const CALLBACK_PATH = "/api/cloud/connect/callback";
const MAX_LINKS_PER_ORG = 3;

export class LinkError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const now = (ctx) => (ctx.now ? ctx.now() : Math.floor(Date.now() / 1000));

async function digest(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
export async function sha256Utf8(text) {
  return bytesToHex(await digest(new Uint8Array(utf8Bytes(text))));
}
function base64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function pkceChallenge(verifier) {
  return base64url(await digest(new Uint8Array(utf8Bytes(verifier))));
}
function sameText(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(utf8Bytes(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(utf8Bytes(message)))));
}

// --- signing -----------------------------------------------------------------------
export async function signRequest({ linkId, secret }, method, pathWithQuery, bodyText, ts) {
  const body = await sha256Utf8(bodyText || "");
  const sig = await hmacHex(secret, method.toUpperCase() + "\n" + pathWithQuery + "\n" + ts + "\n" + body);
  return "Risulta-Link id=" + linkId + ", ts=" + ts + ", sig=" + sig;
}

export const forwardBase = (link) => link.forward_origin || link.remote_origin;

export function parseLinkHeader(value) {
  const match = /^Risulta-Link id=([A-Za-z0-9_-]{4,64}), ts=(\d{1,12}), sig=([0-9a-f]{64})$/.exec(String(value || ""));
  return match ? { linkId: match[1], ts: Number(match[2]), sig: match[3] } : null;
}

// Returns the active link the request is signed by, or null. Never says why.
export async function verifyLinkRequest(ctx, request, bodyText) {
  const parsed = parseLinkHeader(request.headers.get("authorization"));
  if (!parsed) return null;
  const t = now(ctx);
  if (Math.abs(t - parsed.ts) > SKEW_SECONDS) return null;
  if (!(await tableExists(ctx.shared, "links"))) return null;
  const link = await ctx.shared.prepare("SELECT link_id, org_id, instance_origin, secret, state FROM links WHERE link_id = ?").bind(parsed.linkId).first();
  if (!link || link.state !== "active") return null;
  const url = new URL(request.url);
  const expected = await hmacHex(link.secret, request.method.toUpperCase() + "\n" + url.pathname + url.search + "\n" + parsed.ts + "\n" + (await sha256Utf8(bodyText || "")));
  if (!sameText(expected, parsed.sig)) return null;
  return { linkId: link.link_id, orgId: Number(link.org_id), instanceOrigin: link.instance_origin };
}

// --- instance side: start and finish -----------------------------------------------
function cleanOrigin(value, { allowHttp }) {
  let url;
  try { url = new URL(String(value)); } catch { throw new LinkError("bad_origin", "that is not a web address"); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:" && local)) throw new LinkError("bad_origin", "an https address is required");
  if (url.pathname !== "/" || url.search || url.hash || url.username) throw new LinkError("bad_origin", "give an origin without a path");
  return url.origin;
}

export async function cloudLink(ctx) {
  if (!(await tableExists(ctx.shared, "cloud_link"))) return null;
  const row = await ctx.shared.prepare("SELECT remote_origin, forward_origin, link_id, secret, org_slug, org_name, state, created_at FROM cloud_link WHERE id = 1").first();
  return row && row.state === "active" ? row : null;
}

// Step 1, on the instance: remember a state and a verifier, return where to send the browser.
export async function startConnect(ctx, { instanceOrigin, targetOrigin, sessionHash, version = "", format = 1, allowHttp = false }) {
  await ensureSchema(ctx.shared, "shared");
  const instance = cleanOrigin(instanceOrigin, { allowHttp });
  const target = cleanOrigin(targetOrigin, { allowHttp });
  const state = randomHex(16);
  const verifier = randomHex(32);
  const t = now(ctx);
  await ctx.shared.batch([
    ctx.shared.prepare("DELETE FROM connect_states WHERE expires_at < ?").bind(t),
    ctx.shared.prepare("INSERT INTO connect_states (state_hash, verifier, session_hash, target, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256Utf8(state), verifier, sessionHash, target, t + STATE_SECONDS),
  ]);
  const query = "instance=" + encodeURIComponent(instance) + "&state=" + state + "&challenge=" + (await pkceChallenge(verifier)) +
    "&callback=" + encodeURIComponent(instance + CALLBACK_PATH) + "&version=" + encodeURIComponent(version) + "&format=" + format;
  return { url: target + "/connect?" + query, state };
}

// Step 4, on the instance: the browser came back with a code. Exchange it
// server to server. The state is single use and bound to the same browser session.
export async function finishConnect(ctx, { state, code, sessionHash, instanceOrigin, createdBy = 0, fetch: doFetch = fetch, allowHttp = false }) {
  await ensureSchema(ctx.shared, "shared");
  const key = await sha256Utf8(String(state || ""));
  const row = await ctx.shared.prepare("SELECT verifier, session_hash, target, expires_at FROM connect_states WHERE state_hash = ?").bind(key).first();
  // Burn the state whatever happens next.
  await ctx.shared.prepare("DELETE FROM connect_states WHERE state_hash = ?").bind(key).run();
  if (!row || Number(row.expires_at) < now(ctx) || !sameText(row.session_hash, sessionHash)) throw new LinkError("bad_state", "this sign-in link is not valid any more, start again");
  const instance = cleanOrigin(instanceOrigin, { allowHttp });
  const response = await doFetch(row.target + "/api/connect/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: String(code || ""), verifier: row.verifier, instance }),
  });
  if (response.status !== 200) throw new LinkError("exchange_failed", "risulta.dev did not accept the sign-in (" + response.status + ")");
  const data = await response.json();
  if (!data || !/^[A-Za-z0-9_-]{4,64}$/.test(String(data.link_id)) || !/^[0-9a-f]{64}$/.test(String(data.secret))) throw new LinkError("exchange_failed", "risulta.dev sent an unexpected answer");
  // Where the website's traffic is forwarded to (the permanent tracker host, cdn.risulta.dev). Control calls stay on the app origin.
  let forward = "";
  try { forward = data.forward_origin ? cleanOrigin(data.forward_origin, { allowHttp }) : ""; } catch { forward = ""; }
  await ctx.shared.prepare("INSERT OR REPLACE INTO cloud_link (id, remote_origin, forward_origin, link_id, secret, org_slug, org_name, state, created_by, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
    .bind(row.target, forward, data.link_id, data.secret, String((data.org && data.org.slug) || ""), String((data.org && data.org.name) || ""), createdBy, now(ctx)).run();
  return { remote: row.target, linkId: data.link_id, org: data.org || {} };
}

export async function disconnectInstance(ctx) {
  if (!(await tableExists(ctx.shared, "cloud_link"))) return;
  await ctx.shared.prepare("DELETE FROM cloud_link WHERE id = 1").run();
}

// --- target side: consent and redeem ------------------------------------------------
// Step 3, on risulta.dev, after the signed-in org owner or admin pressed Authorize.
export async function authorizeConnect(ctx, { userId, orgId, instance, state, challenge, callback, allowHttp = false }) {
  await ensureSchema(ctx.shared, "shared");
  const origin = cleanOrigin(instance, { allowHttp });
  if (callback !== origin + CALLBACK_PATH) throw new LinkError("bad_callback", "the return address must be the instance's own connect address");
  if (!/^[0-9a-f]{32}$/.test(String(state))) throw new LinkError("bad_state", "bad state");
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(challenge))) throw new LinkError("bad_challenge", "bad challenge");
  const active = (await ctx.shared.prepare("SELECT count(*) AS n FROM links WHERE org_id = ? AND state = 'active' AND instance_origin != ?").bind(orgId, origin).first()).n;
  if (Number(active) >= MAX_LINKS_PER_ORG) throw new LinkError("too_many_links", "this org already has the most instances it can link");
  const code = randomHex(16);
  const t = now(ctx);
  await ctx.shared.batch([
    ctx.shared.prepare("DELETE FROM connect_codes WHERE expires_at < ?").bind(t - 3600),
    ctx.shared.prepare("INSERT INTO connect_codes (code_hash, org_id, user_id, instance_origin, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(await sha256Utf8(code), orgId, userId, origin, challenge, t + CODE_SECONDS),
  ]);
  return { redirect: callback + "?code=" + code + "&state=" + state };
}

// Step 4, on risulta.dev: the instance redeems the code. One answer for every
// failure, so a code cannot be probed.
export async function redeemCode(ctx, { code, verifier, instance, org, forward = "" }) {
  await ensureSchema(ctx.shared, "shared");
  const t = now(ctx);
  const hash = await sha256Utf8(String(code || ""));
  const row = await ctx.shared.prepare("SELECT org_id, user_id, instance_origin, challenge, expires_at, used_at FROM connect_codes WHERE code_hash = ?").bind(hash).first();
  const bad = new LinkError("invalid_code", "the code is not valid");
  if (!row || Number(row.used_at) || Number(row.expires_at) < t) throw bad;
  if (!/^[0-9a-f]{64}$/.test(String(verifier || ""))) throw bad;
  if (!sameText(await pkceChallenge(String(verifier)), row.challenge)) throw bad;
  if (!sameText(String(instance || ""), row.instance_origin)) throw bad;
  const linkId = "ln_" + randomHex(8);
  const secret = randomHex(32);
  // Burn the code and create the link in one transaction; the insert runs only if the burn changed a row.
  const results = await ctx.shared.batch([
    ctx.shared.prepare("UPDATE connect_codes SET used_at = ? WHERE code_hash = ? AND used_at = 0").bind(t, hash),
    ctx.shared.prepare("INSERT INTO links (link_id, org_id, instance_origin, secret, state, created_by, created_at) SELECT ?, ?, ?, ?, 'active', ?, ? WHERE changes() = 1").bind(linkId, row.org_id, row.instance_origin, secret, row.user_id, t),
    ctx.shared.prepare("UPDATE links SET state = 'revoked' WHERE org_id = ? AND instance_origin = ? AND state = 'active' AND link_id != ? AND EXISTS (SELECT 1 FROM links WHERE link_id = ?)").bind(row.org_id, row.instance_origin, linkId, linkId),
  ]);
  if (!results[1].meta.changes) throw bad;
  return { link_id: linkId, secret, org: org || { id: Number(row.org_id) }, forward_origin: forward };
}

export async function listLinks(ctx, orgId) {
  if (!(await tableExists(ctx.shared, "links"))) return [];
  return (await ctx.shared.prepare("SELECT link_id, instance_origin, state, created_at, last_seen FROM links WHERE org_id = ? ORDER BY created_at DESC").bind(orgId).all()).results;
}

export async function revokeLink(ctx, orgId, linkId) {
  if (!(await tableExists(ctx.shared, "links"))) return false;
  const result = await ctx.shared.prepare("UPDATE links SET state = 'revoked' WHERE link_id = ? AND org_id = ? AND state = 'active'").bind(linkId, orgId).run();
  return result.meta.changes > 0;
}
