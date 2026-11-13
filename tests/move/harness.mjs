// Two instances in one process, joined the way production joins them: through
// the real link routes, signed requests and the real saga. The "network" is a
// function that can lose a response, refuse a connection or fail a request.
import { Hono } from "hono";
import { makeWorld, addSite, addEvents, addMeta, prng } from "./helpers.mjs";
import { mountLinkRoutes, mountMoveRoutes } from "../../src/move/routes.js";
import { collectEvent } from "../../src/move/gateway.js";
import { visitorFor } from "../../src/store.js";

export const NOW = 1800000000;
export const INSTANCE = "https://stats.example.test";
export const CLOUD = "https://app.risulta.test";
export const CDN = "https://cdn.risulta.test";

export function makeHost(name, orgId, extra = {}) {
  const world = makeWorld([orgId]);
  world.ctx.now = () => NOW;
  world.ctx.visitorFor = visitorFor;
  Object.assign(world.ctx, extra);
  const app = new Hono();
  const state = { adminOrg: orgId, admin: true };
  const faults = { down: false, dropNext: 0, failNext: 0, calls: 0, sent: [] };
  const peer = { fetch: null };
  const deps = {
    ctx: () => world.ctx,
    admin: async () => (state.admin ? { userId: 1, orgId: state.adminOrg, csrf: "csrf", sessionHash: "session-" + name, email: name + "@example.test" } : null),
    csrfOk: () => true,
    origin: () => (name === "instance" ? INSTANCE : CLOUD),
    cloudOrigin: () => CLOUD,
    allowHttp: false,
    version: "0.2.2",
    page: (c, title, html) => new Response(html, { headers: { "content-type": "text/html" } }),
    orgInfo: async () => ({ slug: "acme", name: "Acme" }),
    forwardOrigin: () => CDN,
    widget: async () => ({ pageviews: 7 }),
    fetch: (url, init) => peer.fetch(url, init),
  };
  mountLinkRoutes(app, deps);
  mountMoveRoutes(app, deps);
  return { state, name, orgId, world, ctx: world.ctx, app, faults, peer, deps, shared: world.shared, store: world.stores[orgId] };
}

// Connect two hosts. Calls to `to`'s origin go through `faults` of `to`.
export function wire(from, to, toOrigin) {
  from.peer.fetch = async (url, init = {}) => {
    const f = to.faults;
    f.calls++;
    f.sent.push(String(url));
    if (f.down) throw new Error("connection refused");
    if (f.failNext > 0) { f.failNext--; return new Response("{}", { status: 503 }); }
    const request = new Request(url, init);
    const response = await to.app.fetch(request);
    if (f.dropNext > 0) { f.dropNext--; throw new Error("response lost"); }
    return response;
  };
  void toOrigin;
}

export async function connect(instance, cloud) {
  wire(instance, cloud, CLOUD);
  wire(cloud, instance, INSTANCE);
  const start = await instance.app.fetch(new Request(INSTANCE + "/api/cloud/connect/start", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "csrf" }, body: "{}" }));
  const { url } = await start.json();
  const consent = await cloud.app.fetch(new Request(url));
  if (consent.status !== 200) throw new Error("consent " + consent.status);
  const q = new URL(url).searchParams;
  const authorize = await cloud.app.fetch(new Request(CLOUD + "/api/connect/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "csrf", instance: q.get("instance"), state: q.get("state"), challenge: q.get("challenge"), callback: q.get("callback") }).toString() }));
  if (authorize.status !== 303) throw new Error("authorize " + authorize.status + " " + (await authorize.text()));
  const back = authorize.headers.get("location");
  const callback = await instance.app.fetch(new Request(back));
  if (callback.status !== 303 || !callback.headers.get("location").includes("connected=1")) throw new Error("callback " + callback.status + " " + callback.headers.get("location"));
  return { url, back };
}

export async function seedSource(host, { events = 2000, key = "k".repeat(32), domain = "shop.test", seed = 1 } = {}) {
  const id = await addSite(host.world, host.orgId, { name: "Shop", domain, key });
  await addEvents(host.world, host.orgId, id, events, { seed });
  return id;
}

// A whole instance: several websites with history, people with access, goals/funnels/notes on the first.
export async function seedInstance(host, sites = [{ key: "k".repeat(32), domain: "shop.test", events: 1500 }, { key: "m".repeat(32), domain: "blog.test", events: 900 }, { key: "q".repeat(32), domain: "docs.test", events: 400 }]) {
  const ids = [];
  let seed = 1;
  for (const s of sites) {
    const id = await addSite(host.world, host.orgId, { name: s.domain.split(".")[0], domain: s.domain, key: s.key });
    await addEvents(host.world, host.orgId, id, s.events, { seed: seed++ });
    ids.push(id);
  }
  await addMeta(host.world, host.orgId, ids[0]);
  const sh = host.shared;
  await sh.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES ('boss@example.test', 'HASH-SECRET', 'admin', 'Boss', 1), ('viewer@example.test', 'HASH-SECRET-2', 'viewer', 'View', 1)").run();
  await sh.prepare("INSERT INTO site_users (user_id, site_id, role) VALUES ((SELECT id FROM users WHERE email = 'viewer@example.test'), ?, 'viewer')").bind(ids[1]).run();
  return ids;
}

// What the collector does for one beacon: hash, then store or queue.
let seq = 0;
export async function beacon(host, siteId, key, { path, ip = "203.0.113.9", ua = "ua" } = {}) {
  const site = { id: siteId, domain: "shop.test" };
  const visitor = await visitorFor(host.store, siteId, ip, ua);
  const p = path || "/e/" + ++seq;
  const row = { ts: NOW - 100, name: "pageview", path: p, referrer: "", visitor, source: "", medium: "", campaign: "", content: "", term: "", value: null };
  const outcome = await collectEvent(host.ctx, host.orgId, site, row, { key, ip, ua, origin: INSTANCE, host: "stats.example.test" });
  return { path: p, outcome };
}
export { prng };
