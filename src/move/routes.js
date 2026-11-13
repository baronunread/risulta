// HTTP surface of the move feature, as two mounts so the host app decides
// where the session gate sits:
//
//   mountLinkRoutes(app, deps)   BEFORE the gate: routes that authenticate
//                                themselves (a signed link, a single-use code)
//   mountMoveRoutes(app, deps)   AFTER the gate: signed-in admin pages and APIs
//
// deps (everything the host supplies):
//   ctx(c)            { shared, store(orgId), blobs, now?, visitorFor, limits? }
//   admin(c)          the signed-in instance or org admin { userId, orgId, csrf, sessionHash, email } or null
//   csrfOk(c, body)   true when the request carries the session's CSRF token
//   origin(c)         this app's public origin (RISULTA_BASE_URL)
//   cloudOrigin(c)    where an instance connects to (default https://app.risulta.dev)
//   fetch             outbound fetch (default global)
//   page(c, title, html)   wraps a page in the app shell
//   orgInfo(ctx, orgId)    { slug, name } shown on the consent screen
//   widget(c, key)         data for a public widget (target side forwards)
import { asciiJson, escapeHtml } from "../util.js";
import { verifyLinkRequest, forwardBase, sha256Utf8, startConnect, finishConnect, authorizeConnect, redeemCode, cloudLink, disconnectInstance, listLinks, revokeLink, LinkError, CALLBACK_PATH } from "./link.js";
import { receiveForwarded, flushOutbox, outboxStats, siteHome, FWD_PATH } from "./gateway.js";
import { MoveError, previewMoveOut, startMoveOut, startMoveBack, runMove, cancelMove, moveStatus, listMoves, retireGateway, targetPreflight, targetOpenWindow, targetJobPart, targetJobComplete, targetJobStatus, targetFinalize, targetCancel, targetBack, MOVE_SETTLED } from "./moves.js";
import { exportParts, estimateExport, ExportError } from "./exporter.js";
import { ensureSchema, tableExists } from "./schema.js";
import { getSite, siteOrg, listOrgSites } from "./registry.js";
import { signRequest } from "./link.js";
import { BundleError } from "./bundle.js";
import { ImportError, createImportJob, addPart, completeUpload, runJob, previewJob, startJob, cancelJob, listInvitations, pendingInvitations, dismissInvitation } from "./importer.js";

const MOVE_CSP = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

function json(data, status = 200, headers = {}) {
  return new Response(asciiJson(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
async function bodyOf(request) {
  if (request.method === "GET" || request.method === "HEAD") return "";
  const body = request.body;
  if (body && !(body instanceof ReadableStream)) return String(body);
  return await request.text();
}
function fail(error) {
  if (error instanceof MoveError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof ExportError) return json({ error: error.message, code: error.code }, error.code === "not_found" ? 404 : 400);
  if (error instanceof LinkError) return json({ error: error.message, code: error.code }, 400);
  if (error instanceof ImportError || error instanceof BundleError) return json({ error: error.message, code: error.code }, 400);
  throw error;
}

// ---------------------------------------------------------------------------------------------------
export function mountLinkRoutes(app, deps) {
  // Redeem a connect code. One answer for every failure.
  app.post("/api/connect/token", async (c) => {
    const ctx = deps.ctx(c);
    let input;
    try { input = JSON.parse(await bodyOf(c.req.raw)); } catch { return json({ error: "invalid code", code: "invalid_code" }, 400); }
    if (deps.rateLimit && !(await deps.rateLimit(c, "connect-token"))) return json({ error: "slow down" }, 429);
    try {
      const row = await ctx.shared.prepare("SELECT org_id FROM connect_codes WHERE code_hash = ?").bind(await sha256Utf8(String((input && input.code) || ""))).first().catch(() => null);
      const org = row && deps.orgInfo ? await deps.orgInfo(ctx, Number(row.org_id)) : null;
      return json(await redeemCode(ctx, { code: input.code, verifier: input.verifier, instance: input.instance, org, forward: deps.forwardOrigin ? deps.forwardOrigin(c) : "" }));
    } catch (error) {
      if (error instanceof LinkError) return json({ error: "invalid code", code: "invalid_code" }, 400);
      throw error;
    }
  });

  // Every link route: signature first, and a failure looks exactly like a missing route.
  const linked = (handler) => async (c) => {
    const ctx = deps.ctx(c);
    const body = await bodyOf(c.req.raw);
    const link = await verifyLinkRequest(ctx, c.req.raw, body);
    if (!link) return notFound();
    try {
      return await handler(c, ctx, link, body);
    } catch (error) {
      return fail(error);
    }
  };
  const lineage = (c) => c.req.param("lineage");
  app.post("/api/link/moves/preflight", linked(async (c, ctx, link, body) => json(await targetPreflight(ctx, link, JSON.parse(body)))));
  app.post("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/windows", linked(async (c, ctx, link, body) => json(await targetOpenWindow(ctx, link, lineage(c), JSON.parse(body || "{}")))));
  app.put("/api/link/jobs/:id{[0-9a-f]{32}}/parts/:n{[0-9]{1,6}}", linked(async (c, ctx, link, body) => json(await targetJobPart(ctx, link, c.req.param("id"), Number(c.req.param("n")), body, c.req.header("x-risulta-part-sha256") || ""))));
  app.post("/api/link/jobs/:id{[0-9a-f]{32}}/complete", linked(async (c, ctx, link) => json(await targetJobComplete(ctx, link, c.req.param("id")))));
  app.get("/api/link/jobs/:id{[0-9a-f]{32}}", linked(async (c, ctx, link) => json(await targetJobStatus(ctx, link, c.req.param("id")))));
  app.post("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/finalize", linked(async (c, ctx, link) => json(await targetFinalize(ctx, link, lineage(c)))));
  app.post("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/cancel", linked(async (c, ctx, link) => json(await targetCancel(ctx, link, lineage(c)))));
  app.post("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/preflight", linked(async (c, ctx, link) => json(await targetBack.preflight(ctx, link, lineage(c)))));
  app.get("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/export", linked(async (c, ctx, link) => {
    const q = new URL(c.req.url).searchParams;
    return json(await targetBack.export(ctx, link, lineage(c), { sinceId: Number(q.get("since_id")) || 0, untilId: Number(q.get("until_id")) || 0, limit: Number(q.get("limit")) || 0 }));
  }));
  app.post("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/seal", linked(async (c, ctx, link) => json(await targetBack.seal(ctx, link, lineage(c)))));
  app.post("/api/link/moves/:lineage{[a-z0-9._-]{8,64}}/back/release", linked(async (c, ctx, link) => json(await targetBack.release(ctx, link, lineage(c)))));

  // Forwarded events. The visitor address and hash are trusted only from here.
  app.post(FWD_PATH, linked(async (c, ctx, link, body) => {
    const result = await receiveForwarded(ctx, link, body);
    return json({ results: result.results }, result.status);
  }));
  // Widget data for a moved site, served to its gateway.
  app.get("/link/fwd/public/data/:key{[A-Za-z0-9_-]+}", linked(async (c, ctx, link) => {
    const key = c.req.param("key");
    const site = await ctx.shared.prepare("SELECT sites.id FROM sites JOIN site_links ON site_links.site_id = sites.id WHERE sites.public_key = ? AND site_links.link_id = ?").bind(key, link.linkId).first();
    if (!site || !deps.widget) return json({ error: "public sharing unavailable" }, 404);
    const data = await deps.widget(c, key);
    return json(data || { error: "public sharing unavailable" }, data ? 200 : 404);
  }));
}

// ---------------------------------------------------------------------------------------------------
const CACHE = new Map();
async function gatewayGet(ctx, link, path, doFetch, ttlMs, nowMs = Date.now()) {
  const hit = CACHE.get(link.link_id + path);
  if (hit && nowMs - hit.at < ttlMs) return hit.value;
  const response = await doFetch(forwardBase(link) + path, { method: "GET", headers: { authorization: await signRequest({ linkId: link.link_id, secret: link.secret }, "GET", path, "", Math.floor(nowMs / 1000)) } });
  const value = { status: response.status, body: await response.text() };
  if (CACHE.size > 64) CACHE.clear();
  CACHE.set(link.link_id + path, { at: nowMs, value });
  return value;
}

// For the host's public widget routes: returns widget data from risulta.dev when the site is a gateway, else undefined.
export async function gatewayWidgetData(ctx, site, key, doFetch = fetch) {
  const home = await siteHome(ctx, site.id);
  if (home.home !== "gateway" && home.home !== "frozen") return undefined;
  if (home.home === "frozen") return null;
  const link = await cloudLink(ctx);
  if (!link) return null;
  const answer = await gatewayGet(ctx, link, "/link/fwd/public/data/" + key, doFetch, 60000);
  return answer.status === 200 ? JSON.parse(answer.body) : null;
}

export function mountMoveRoutes(app, deps) {
  const doFetch = deps.fetch || fetch;
  const allowHttpFor = (c) => (deps.allowHttpFor ? deps.allowHttpFor(c) : !!deps.allowHttp);
  const wrap = (handler, { write = false } = {}) => async (c) => {
    const admin = await deps.admin(c);
    if (!admin) return json({ error: "forbidden" }, 403);
    const ctx = deps.ctx(c);
    const body = await bodyOf(c.req.raw);
    if (write && !deps.csrfOk(c, body)) return json({ error: "csrf mismatch" }, 403);
    try {
      return await handler(c, ctx, admin, body);
    } catch (error) {
      return fail(error);
    }
  };
  const html = (c, title, inner) => deps.page(c, title, inner);
  const redirect = (to) => new Response("", { status: 303, headers: { location: to } });
  const drive = () => ({ fetch: doFetch, pollMs: 0 });
  const wantsJson = (c) => (c.req.header("content-type") || "").indexOf("application/json") >= 0 || (c.req.header("accept") || "").indexOf("application/json") >= 0;

  // --- instance: connect ---------------------------------------------------------------
  app.get("/api/cloud/status", wrap(async (c, ctx) => {
    const link = await cloudLink(ctx);
    const moves = await listMoves(ctx);
    return json({ connected: !!link, remote: link ? link.remote_origin : "", org: link ? { slug: link.org_slug, name: link.org_name } : null, moves });
  }));
  app.post("/api/cloud/connect/start", wrap(async (c, ctx, admin) => {
    const started = await startConnect(ctx, { instanceOrigin: deps.origin(c), targetOrigin: deps.cloudOrigin(c), sessionHash: admin.sessionHash, version: deps.version || "", allowHttp: allowHttpFor(c) });
    return wantsJson(c) ? json({ url: started.url }) : redirect(started.url);
  }, { write: true }));
  app.get(CALLBACK_PATH, wrap(async (c, ctx, admin) => {
    const q = new URL(c.req.url).searchParams;
    try {
      await finishConnect(ctx, { state: q.get("state"), code: q.get("code"), sessionHash: admin.sessionHash, instanceOrigin: deps.origin(c), createdBy: admin.userId, fetch: doFetch, allowHttp: allowHttpFor(c) });
    } catch (error) {
      if (error instanceof LinkError) return redirect("/cloud?error=" + encodeURIComponent(error.code));
      throw error;
    }
    return redirect("/cloud?connected=1");
  }));
  app.post("/api/cloud/disconnect", wrap(async (c, ctx) => {
    if (await tableExists(ctx.shared, "site_home")) {
      const forwarding = await ctx.shared.prepare("SELECT count(*) AS n FROM site_home WHERE home IN ('gateway','moving-back')").first();
      if (Number(forwarding.n) > 0) throw new MoveError("gateway_active", "this instance still forwards its traffic to risulta.dev: move everything back or retire the gateway first", 409);
    }
    await disconnectInstance(ctx);
    return wantsJson(c) ? json({ ok: true }) : redirect("/cloud");
  }, { write: true }));

  // --- instance: moves (the whole instance, never a single website) -----------------------------------
  app.post("/api/cloud/move/preview", wrap(async (c, ctx, admin) => json(await previewMoveOut(ctx, admin.orgId, drive())), { write: true }));
  app.post("/api/cloud/move", wrap(async (c, ctx, admin, body) => {
    const input = body && body.charAt(0) === "{" ? JSON.parse(body) : {};
    const started = await startMoveOut(ctx, admin.orgId, { window: Math.min(50000, Math.max(500, Math.floor(Number(input.window)) || 0)) || undefined }, drive());
    return wantsJson(c) ? json(started, 202) : redirect("/cloud/moves/" + started.id);
  }, { write: true }));
  app.post("/api/cloud/move-back", wrap(async (c, ctx, admin) => {
    const started = await startMoveBack(ctx, admin.orgId);
    return wantsJson(c) ? json(started, 202) : redirect("/cloud/moves/" + started.id);
  }, { write: true }));
  app.post("/api/cloud/retire-gateway", wrap(async (c, ctx, admin) => {
    await retireGateway(ctx, admin.orgId);
    return wantsJson(c) ? json({ ok: true }) : redirect("/cloud");
  }, { write: true }));
  // Polling is what advances a move on a host with no background worker: one bounded step per call.
  app.get("/api/moves/:id{[0-9a-f]{32}}", wrap(async (c, ctx) => {
    const current = await moveStatus(ctx, c.req.param("id"));
    if (!current) return json({ error: "not found" }, 404);
    if (MOVE_SETTLED.indexOf(current.state) >= 0) return json(current);
    return json(await runMove(ctx, c.req.param("id"), drive(), { maxSteps: 3, budgetMs: 1200 }));
  }));
  app.post("/api/moves/:id{[0-9a-f]{32}}/cancel", wrap(async (c, ctx) => {
    const status = await cancelMove(ctx, c.req.param("id"), drive());
    return wantsJson(c) ? json(status) : redirect("/cloud");
  }, { write: true }));

  // --- download your data -------------------------------------------------------------------
  // Streams the bundle: 4 MiB parts, never the whole file in memory.
  app.get("/api/exports/download", wrap(async (c, ctx, admin) => {
    const q = new URL(c.req.url).searchParams;
    // Everything by default. `site=` (or `sites=`) narrows it for scripts; the pages never offer a choice.
    const wanted = String(q.get("sites") || q.get("site") || "").split(",").filter(Boolean).map(Number);
    if (wanted.some((n) => !Number.isInteger(n) || n < 1)) return json({ error: "bad site" }, 400);
    const ids = wanted.length ? wanted : (await listOrgSites(ctx.shared, admin.orgId)).map((site) => Number(site.id));
    if (!ids.length) return json({ error: "this instance has no websites" }, 409);
    const opts = { orgId: admin.orgId, siteIds: ids, sinceId: Number(q.get("since_id")) || 0, includeUsers: q.get("users") !== "0", scope: wanted.length === 1 ? "site" : "org", partBytes: 250000 };
    await estimateExport(ctx, opts); // refuses a site that is not yours before any byte is sent
    const parts = exportParts(ctx, opts);
    const stream = new ReadableStream({
      async pull(controller) {
        const next = await parts.next();
        if (next.done) controller.close();
        else controller.enqueue(new TextEncoder().encode(next.value.text));
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "content-disposition": 'attachment; filename="risulta-' + (wanted.length ? ids.join("-") : "all") + '.bundle.ndjson"', "cache-control": "no-store" } });
  }));

  // --- browser upload (no link): /import ---------------------------------------------------------
  app.post("/api/imports", wrap(async (c, ctx, admin, body) => {
    const input = body ? JSON.parse(body) : {};
    const job = await createImportJob(ctx, { orgId: admin.orgId, options: { retentionDays: (ctx.limits && ctx.limits.retentionDays) || 0, keyOnClash: input.keyOnClash === "new" ? "new" : "fail", onDomainConflict: input.onDomainConflict === "fail" ? "fail" : "skip" } });
    return json({ id: job.id }, 201);
  }, { write: true }));
  app.put("/api/imports/:id{[0-9a-f]{32}}/parts/:n{[0-9]{1,6}}", wrap(async (c, ctx, admin, body) => {
    await addPart(ctx, c.req.param("id"), admin.orgId, Number(c.req.param("n")), body, c.req.header("x-risulta-part-sha256") || "");
    return json({ ok: true });
  }, { write: true }));
  app.post("/api/imports/:id{[0-9a-f]{32}}/complete", wrap(async (c, ctx, admin) => {
    await completeUpload(ctx, c.req.param("id"), admin.orgId);
    return json(await runJob(ctx, c.req.param("id"), admin.orgId, { budgetMs: 1200 }));
  }, { write: true }));
  app.get("/api/imports/:id{[0-9a-f]{32}}", wrap(async (c, ctx, admin) => {
    const status = await runJob(ctx, c.req.param("id"), admin.orgId, { budgetMs: 1200 });
    if (!status) return json({ error: "not found" }, 404);
    const out = { ...status };
    if (status.state === "verified") out.preview = await previewJob(ctx, c.req.param("id"), admin.orgId);
    return json(out);
  }));
  app.get("/api/imports/:id{[0-9a-f]{32}}/invitations", wrap(async (c, ctx, admin) => json({ invitations: await listInvitations(ctx, c.req.param("id"), admin.orgId) })));
  app.post("/api/imports/:id{[0-9a-f]{32}}/start", wrap(async (c, ctx, admin, body) => {
    await startJob(ctx, c.req.param("id"), admin.orgId, body ? JSON.parse(body) : {});
    return json(await runJob(ctx, c.req.param("id"), admin.orgId, { budgetMs: 1200 }));
  }, { write: true }));
  app.post("/api/imports/:id{[0-9a-f]{32}}/cancel", wrap(async (c, ctx, admin) => {
    await cancelJob(ctx, c.req.param("id"), admin.orgId);
    return json(await runJob(ctx, c.req.param("id"), admin.orgId, { budgetMs: 1200 }));
  }, { write: true }));
  app.get("/import", wrap(async (c, ctx, admin) => html(c, "Import", importPage(admin))));

  // --- target: the people a moved instance had, waiting for the owner ---------------------------------
  app.get("/api/invitations", wrap(async (c, ctx, admin) => json({ invitations: await pendingInvitations(ctx, admin.orgId) })));
  app.delete("/api/invitations/:id{[0-9]+}", wrap(async (c, ctx, admin) => json({ ok: await dismissInvitation(ctx, admin.orgId, Number(c.req.param("id"))) }), { write: true }));

  // --- target: links and consent ----------------------------------------------------------------
  app.get("/api/links", wrap(async (c, ctx, admin) => json({ links: await listLinks(ctx, admin.orgId) })));
  app.delete("/api/links/:id{[A-Za-z0-9_-]{4,64}}", wrap(async (c, ctx, admin) => json({ ok: await revokeLink(ctx, admin.orgId, c.req.param("id")) }), { write: true }));
  app.get("/connect", wrap(async (c, ctx, admin) => {
    const q = new URL(c.req.url).searchParams;
    const org = deps.orgInfo ? await deps.orgInfo(ctx, admin.orgId) : { slug: "default", name: "Default" };
    return html(c, "Connect", consentPage({ admin, org, instance: q.get("instance") || "", state: q.get("state") || "", challenge: q.get("challenge") || "", callback: q.get("callback") || "", version: q.get("version") || "" }));
  }));
  app.post("/api/connect/authorize", wrap(async (c, ctx, admin, body) => {
    const form = new URLSearchParams(body);
    const result = await authorizeConnect(ctx, { userId: admin.userId, orgId: admin.orgId, instance: form.get("instance"), state: form.get("state"), challenge: form.get("challenge"), callback: form.get("callback"), allowHttp: allowHttpFor(c) });
    return redirect(result.redirect);
  }, { write: true }));

  // --- pages -----------------------------------------------------------------------------------------
  app.get("/cloud", wrap(async (c, ctx, admin) => {
    const link = await cloudLink(ctx);
    const sites = await listOrgSites(ctx.shared, admin.orgId);
    const homes = {};
    if (await tableExists(ctx.shared, "site_home")) for (const row of (await ctx.shared.prepare("SELECT site_id, home FROM site_home").all()).results) homes[row.site_id] = row.home;
    const moves = await listMoves(ctx);
    const q = new URL(c.req.url).searchParams;
    const stats = link ? await outboxStats(ctx, admin.orgId) : { queued: 0, oldest: 0 };
    const invitations = await pendingInvitations(ctx, admin.orgId);
    return html(c, "risulta.dev", cloudPage({ admin, link, sites, homes, moves, stats, invitations, error: q.get("error") || "", connected: q.get("connected") === "1", cloudOrigin: deps.cloudOrigin(c) }));
  }));
  app.get("/cloud/move", wrap(async (c, ctx, admin) => {
    const preview = await previewMoveOut(ctx, admin.orgId, drive());
    return html(c, "Move to risulta.dev", previewPage({ admin, preview }));
  }));
  app.get("/cloud/moves/:id{[0-9a-f]{32}}", wrap(async (c, ctx, admin) => {
    let status = await moveStatus(ctx, c.req.param("id"));
    if (!status) return notFound();
    if (MOVE_SETTLED.indexOf(status.state) < 0) status = await runMove(ctx, c.req.param("id"), drive(), { maxSteps: 3, budgetMs: 1200 });
    return html(c, "Move", progressPage({ admin, status }));
  }));
}

// The every-minute tick: flush the gateway outbox and give every live move a bounded turn.
export async function moveTick(ctx, orgIds, deps = {}) {
  const doFetch = deps.fetch || fetch;
  if (!(await tableExists(ctx.shared, "moves")) && !(await tableExists(ctx.shared, "site_home"))) return { flushed: 0, moves: 0 };
  let flushed = 0;
  for (const orgId of orgIds) {
    for (let i = 0; i < 20; i++) {
      const r = await flushOutbox(ctx, orgId, { fetch: doFetch });
      flushed += r.sent;
      if (!r.sent || !r.left) break;
    }
  }
  let moves = 0;
  if (await tableExists(ctx.shared, "moves")) {
    const live = (await ctx.shared.prepare("SELECT id FROM moves WHERE state IN ('preflight','bulk','seal','catchup','finalize','pull')").all()).results;
    for (const row of live) { await runMove(ctx, row.id, { fetch: doFetch }, { maxSteps: 3, budgetMs: 1000 }); moves++; }
  }
  return { flushed, moves };
}
export { ensureSchema, getSite, siteOrg, escapeHtml };

// --- HTML -----------------------------------------------------------------------------------------------
const e = escapeHtml;
const csrfField = (admin) => '<input type="hidden" name="csrf" value="' + e(admin.csrf) + '">';

const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

function cloudPage({ admin, link, sites, homes, moves, stats, invitations, error, connected, cloudOrigin }) {
  const states = Object.values(homes);
  const forwarding = states.indexOf("gateway") >= 0;
  const retired = !forwarding && states.indexOf("frozen") >= 0;
  const busy = states.indexOf("moving") >= 0 || states.indexOf("moving-back") >= 0;
  const form = (action, label, primary) => '<form method="post" action="' + action + '" class="inline">' + csrfField(admin) + '<button class="button' + (primary ? " primary" : "") + '" type="submit">' + label + "</button></form>";
  let card;
  if (!link) {
    card = "<p>Link this instance to a risulta.dev account. Connecting moves nothing: afterwards one button moves everything.</p>" +
      form("/api/cloud/connect/start", "Connect to risulta.dev", true) +
      '<p class="muted">You will sign in on ' + e(cloudOrigin) + " and approve the link there.</p>";
  } else {
    const where = "<p>Connected to <strong>" + e(link.org_name || link.org_slug || "your org") + "</strong> on " + e(link.remote_origin) + ".</p>";
    let state;
    if (busy) state = "<p><strong>Moving...</strong> Open the latest move below to follow it.</p>";
    else if (forwarding) state = "<p><strong>Everything lives on risulta.dev.</strong> This instance forwards all tracker traffic there, so no snippet or DNS change is needed.</p>" + form("/api/cloud/move-back", "Move back") + form("/api/cloud/retire-gateway", "Retire the gateway");
    else if (retired) state = "<p><strong>Everything lives on risulta.dev.</strong> This copy is the rollback copy.</p>" + form("/api/cloud/move-back", "Move back");
    else state = "<p>Move " + e(plural(sites.length, "website", "websites")) + ", their goals, funnels, notes, history and the list of people with access to risulta.dev in one go.</p>" +
      (sites.length ? '<p><a class="button primary" href="/cloud/move">Move everything to risulta.dev</a></p>' : '<p class="muted">Add a website first.</p>');
    card = where + state + (busy ? "" : form("/api/cloud/disconnect", "Disconnect"));
  }
  const rows = sites.map((s) => "<tr><td>" + e(s.name) + "</td><td>" + e(s.domain) + "</td><td>" + (homes[s.id] === "gateway" || homes[s.id] === "frozen" ? "on risulta.dev" : homes[s.id] ? "moving" : "here") + "</td></tr>").join("");
  const recent = moves.length ? "<h2>Recent moves</h2><ul>" + moves.map((m) => '<li><a href="/cloud/moves/' + e(m.id) + '">' + e(m.direction) + " " + e(m.state) + "</a></li>").join("") + "</ul>" : "";
  return '<main class="shell" id="main"><h1>risulta.dev</h1>' + (connected ? '<p class="notice">Connected.</p>' : "") + (error ? '<p class="error">That did not work (' + e(error) + "). Try again.</p>" : "") +
    '<section class="card">' + card + "</section>" +
    (stats.queued ? '<p class="muted">' + stats.queued + " forwarded events are waiting to be delivered.</p>" : "") +
    "<h2>Websites</h2><table><thead><tr><th>Name</th><th>Domain</th><th>Lives</th></tr></thead><tbody>" + rows + "</tbody></table>" +
    (invitations.length ? "<h2>People to invite</h2><p class=\"muted\">These people had access to the instance you moved here. Passwords never travel: invite them when you are ready.</p><ul>" + invitations.map((p) => "<li>" + e(p.display_name || p.email) + " (" + e(p.email) + ", " + e(p.role) + ")</li>").join("") + "</ul>" : "") +
    '<p><a href="/api/exports/download">Download all data</a> <span class="muted">(a file you can import into any Risulta)</span></p>' + recent + "</main>";
}

function previewPage({ admin, preview }) {
  const remote = preview.remote || {};
  const rows = preview.sites.map((s) => "<tr><td>" + e(s.name) + "</td><td>" + e(s.domain) + "</td><td>" + s.events + "</td></tr>").join("");
  return '<main class="shell" id="main"><h1>Move everything to risulta.dev</h1><ul>' +
    "<li>" + e(plural(preview.sites.length, "website", "websites")) + " and " + preview.events + " events to copy, with goals, funnels and notes.</li>" +
    (preview.people ? "<li>" + e(plural(preview.people, "person", "people")) + " with access are sent as invitations you confirm on risulta.dev (never passwords).</li>" : "") +
    "<li>Every tracker key stays the same, so no snippet on any website changes.</li>" +
    (remote.retentionDays ? "<li>Events older than " + remote.retentionDays + " days are left out (the plan's retention).</li>" : "") +
    "<li>While it moves, your websites keep collecting. After it, this instance forwards all of their traffic to risulta.dev and the dashboards live there. No event is lost or counted twice.</li>" +
    "<li>Websites cannot be added here while the instance is moved. This copy stays as a rollback copy until you remove it, and Move back returns everything.</li></ul>" +
    "<table><thead><tr><th>Website</th><th>Domain</th><th>Events</th></tr></thead><tbody>" + rows + "</tbody></table>" +
    '<form method="post" action="/api/cloud/move">' + csrfField(admin) +
    '<p><button class="button primary" type="submit">Move everything</button> <a class="button" href="/cloud">Cancel</a></p></form></main>';
}

function progressPage({ admin, status }) {
  const live = MOVE_SETTLED.indexOf(status.state) < 0;
  const labels = { preflight: "Checking", bulk: "Copying history", pull: "Copying history back", seal: "Switching traffic", catchup: "Catching up", finalize: "Verifying", done: "Done", returned: "Done", failed: "Failed", cancelled: "Cancelled", needs_attention: "Needs attention" };
  return (live ? '<meta http-equiv="refresh" content="2">' : "") + '<main class="shell" id="main"><h1>' + (status.direction === "back" ? "Move back" : "Move everything to risulta.dev") + "</h1>" +
    "<p><strong>" + e(labels[status.state] || status.state) + "</strong></p>" +
    (status.eventsTotal ? "<p>" + status.eventsSent + " of " + status.eventsTotal + " events</p>" : "") +
    (status.error ? '<p class="error">' + e(status.error) + "</p>" : "") +
    (live && !status.sealedId && status.direction === "out" ? '<form method="post" action="/api/moves/' + e(status.id) + '/cancel">' + csrfField(admin) + '<button class="button" type="submit">Cancel</button></form>' : "") +
    '<p><a href="/cloud">Back to risulta.dev</a></p></main>';
}

function consentPage({ admin, org, instance, state, challenge, callback, version }) {
  return '<main class="shell" id="main"><h1>Link an instance</h1><p>Signed in as <strong>' + e(admin.email || "") + "</strong>, org <strong>" + e(org.name || org.slug) + "</strong>.</p>" +
    "<p>The instance at <strong>" + e(instance) + "</strong>" + (version ? " (version " + e(version) + ")" : "") + " asks to be linked to this org.</p>" +
    "<p>Linked, it can create websites in this org, upload their data and forward their traffic. It cannot read your other websites, change members or billing.</p>" +
    '<form method="post" action="/api/connect/authorize">' + csrfField(admin) +
    '<input type="hidden" name="instance" value="' + e(instance) + '"><input type="hidden" name="state" value="' + e(state) + '"><input type="hidden" name="challenge" value="' + e(challenge) + '"><input type="hidden" name="callback" value="' + e(callback) + '">' +
    '<button class="button primary" type="submit">Authorize</button> <a class="button" href="/">Cancel</a></form></main>';
}

function importPage(admin) {
  return '<main class="shell" id="main"><h1>Import a bundle</h1><p>Choose a risulta bundle (a file from "Download data" on another instance).</p>' +
    '<input type="file" id="bundle" accept=".ndjson,application/x-ndjson"><input type="hidden" id="csrf" value="' + e(admin.csrf) + '"><p id="status" aria-live="polite"></p>' +
    '<script src="/import.js" defer></script></main>';
}
export { MOVE_CSP };
