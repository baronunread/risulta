import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { RisultaDatabase } from "./lib/db.js";

const dir = mkdtempSync(`${tmpdir()}/risulta-`);
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const selected = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(selected));
  });
});
const base = `http://127.0.0.1:${port}`;
const secureBase = `https://127.0.0.1:${port}`;
const adminEmail = "admin@example.com";
const adminPassword = "correct horse battery staple";

const version = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["app.js", "--version"]);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error("version command failed")));
});
assert.equal(version, "dev");

function start(extraEnv = {}) {
  const executable = process.env.RISULTA_TEST_BINARY || process.execPath;
  const child = spawn(executable, process.env.RISULTA_TEST_BINARY ? [] : ["app.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, RISULTA_MAX_OPEN_SITES: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.errors = () => errors;
  return child;
}

async function ready(child) {
  await Promise.race([
    new Promise((resolve) => child.stdout.on("data", (chunk) => { if (String(chunk).includes("risulta on")) resolve(); })),
    new Promise((_, reject) => child.once("exit", (code) => reject(new Error(`Risulta exited ${code}: ${child.errors()}`)))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Risulta did not start")), 5000)),
  ]);
}

async function stop(child) {
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, `clean shutdown: ${child.errors()}`);
}

async function command(args, env = {}) {
  const executable = process.env.RISULTA_TEST_BINARY || process.execPath;
  const child = spawn(executable, process.env.RISULTA_TEST_BINARY ? args : ["app.js", ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, output, errors };
}

const request = (path, options = {}) => fetch(`${base}${path}`, { redirect: "manual", ...options });
const form = (values) => new URLSearchParams(values);
const csrfFrom = (html) => {
  const match = html.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match, "CSRF token rendered");
  return match[1];
};
const cookieFrom = (response) => {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "session cookie set");
  return value.split(";")[0];
};

async function login(email, password, headers = {}) {
  const response = await request("/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
    body: form({ email, password }),
  });
  assert.equal(response.status, 303);
  return cookieFrom(response);
}

let app = start({ RISULTA_ADMIN_EMAIL: adminEmail, RISULTA_ADMIN_PASSWORD: adminPassword, RISULTA_INGEST_RATE_LIMIT: "3" });
await ready(app);

assert.equal((await request("/healthz")).status, 200);
const anonymous = await request("/");
assert.equal(anonymous.status, 303);
assert.equal(anonymous.headers.get("location"), "/login");
const loginHtml = await (await request("/login")).text();
assert.match(loginHtml, /Sign in to Risulta/);
assert.match(loginHtml, /autocomplete="current-password"/);

const badLogin = await request("/login", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
  body: form({ email: adminEmail, password: "wrong password" }),
});
assert.equal(badLogin.status, 401);
assert.match(await badLogin.text(), /Email or password is incorrect/);

const adminCookie = await login(adminEmail, adminPassword);
const untrustedForwardedCookie = await login(adminEmail, adminPassword, { "x-forwarded-proto": "https" });
assert.match(untrustedForwardedCookie, /^risulta_session=/, "untrusted forwarding headers are ignored");
const emptySites = await request("/", { headers: { cookie: adminCookie } });
assert.equal(emptySites.status, 200);
assert.match(await emptySites.text(), /No websites yet/);

const newSiteHtml = await (await request("/admin/sites/new", { headers: { cookie: adminCookie } })).text();
const adminCsrf = csrfFrom(newSiteHtml);
async function createSite(name, domain) {
  const response = await request("/admin/sites", {
    method: "POST",
    headers: { cookie: adminCookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: form({ csrf: adminCsrf, name, domain }),
  });
  assert.equal(response.status, 303);
}
await createSite("Alpha", "alpha.example");
await createSite("Beta", "beta.example");

const control = new DatabaseSync(`${dir}/control.db`, { readOnly: true });
const sites = control.prepare("SELECT id, name, domain, public_key, db_name FROM sites ORDER BY id").all();
assert.equal(sites.length, 2);
const [alpha, beta] = sites;

const trackerResponse = await request(`/js/${alpha.public_key}.js`);
const tracker = await trackerResponse.text();
assert.equal(trackerResponse.status, 200);
assert.ok(Buffer.byteLength(tracker) < 1024, `tracker is ${Buffer.byteLength(tracker)} bytes`);
assert.match(tracker, /pushState/);
assert.match(tracker, new RegExp(alpha.public_key));
const preflight = await request(`/api/event/${alpha.public_key}`, { method: "OPTIONS" });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

async function event(site, domain, path, referrer = "") {
  return request(`/api/event/${site.public_key}`, {
    method: "POST", headers: { "user-agent": "risulta-test" },
    body: JSON.stringify({ name: "pageview", domain, path, referrer }),
  });
}
assert.equal((await event(alpha, alpha.domain, "/alpha-only")).status, 202);
assert.equal((await event(alpha, alpha.domain, "/docs", "https://search.example")).status, 202);
assert.equal((await event(beta, beta.domain, "/beta-only")).status, 202);
assert.equal((await event(alpha, beta.domain, "/spoofed")).status, 400);
const rateLimited = await event(alpha, alpha.domain, "/too-many-events");
assert.equal(rateLimited.status, 429);
assert.equal(rateLimited.headers.get("access-control-allow-origin"), "*");
assert.ok(Number(rateLimited.headers.get("retry-after")) >= 1);

const sitesOverview = await (await request("/", { headers: { cookie: adminCookie } })).text();
assert.match(sitesOverview, /Last 7 days/);
assert.match(sitesOverview, /site-overview/);
assert.match(sitesOverview, /<svg/);
assert.doesNotMatch(sitesOverview, /blobatar\.dev/);

const alphaDashboard = await (await request(`/sites/${alpha.id}?period=30`, { headers: { cookie: adminCookie } })).text();
assert.match(alphaDashboard, /alpha-only/);
assert.doesNotMatch(alphaDashboard, /beta-only/);
assert.match(alphaDashboard, /Last 30 days/);
assert.match(alphaDashboard, /Skip to content/);
assert.doesNotMatch(alphaDashboard, /Install the tracker/);
assert.match(alphaDashboard, /Website settings/);
const alphaToday = await (await request(`/sites/${alpha.id}?period=1`, { headers: { cookie: adminCookie } })).text();
assert.match(alphaToday, /Today/);
assert.match(alphaToday, /alpha-only/);
assert.equal((alphaToday.match(/class="chart-point"/g) || []).length, 24, "Today renders all 24 UTC hourly buckets");
assert.match(alphaToday, /00:00 UTC/);
assert.match(alphaToday, /23:00 UTC/);
const alphaSettings = await request(`/sites/${alpha.id}/settings`, { headers: { cookie: adminCookie } });
assert.equal(alphaSettings.status, 200);
const alphaSettingsHtml = await alphaSettings.text();
assert.match(alphaSettingsHtml, /Tracker code/);
assert.match(alphaSettingsHtml, /favicon-light\.svg/);
assert.match(alphaSettingsHtml, /favicon-dark\.svg/);
assert.match(alphaSettingsHtml, /View source on GitHub/);
assert.match(alphaSettingsHtml, /dev build/);
assert.match(alphaSettingsHtml, /Risulta analytics/);
assert.match(alphaSettingsHtml, /Use minimal one-line snippet/);
assert.match(alphaSettingsHtml, new RegExp(`/js/${alpha.public_key}\\.js`));
assert.doesNotMatch(alphaSettings.headers.get("content-security-policy"), /blobatar\.dev/);
const betaDashboard = await (await request(`/sites/${beta.id}`, { headers: { cookie: adminCookie } })).text();
assert.match(betaDashboard, /beta-only/);
assert.doesNotMatch(betaDashboard, /alpha-only/);

const usersHtml = await (await request("/admin/users", { headers: { cookie: adminCookie } })).text();
assert.match(usersHtml, /Create user/);
const usersCsrf = csrfFrom(usersHtml);
const viewerEmail = "viewer@example.com";
const viewerPassword = "viewer password 123";
const createViewer = await request("/admin/users", {
  method: "POST",
  headers: { cookie: adminCookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams([["csrf", usersCsrf], ["email", viewerEmail], ["password", viewerPassword], ["role", "viewer"], ["site", String(alpha.id)]]),
});
assert.equal(createViewer.status, 303);

const viewerCookie = await login(viewerEmail, viewerPassword);
assert.equal((await request(`/sites/${alpha.id}`, { headers: { cookie: viewerCookie } })).status, 200);
assert.equal((await request(`/sites/${beta.id}`, { headers: { cookie: viewerCookie } })).status, 403);
assert.equal((await request("/admin/users", { headers: { cookie: viewerCookie } })).status, 403);
const badCsrf = await request("/logout", {
  method: "POST", headers: { cookie: viewerCookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
  body: form({ csrf: "incorrect" }),
});
assert.equal(badCsrf.status, 403);
const viewerAccount = await request("/account", { headers: { cookie: viewerCookie } });
const deleteViewer = await request("/account/delete", {
  method: "POST", headers: { cookie: viewerCookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
  body: form({ csrf: csrfFrom(await viewerAccount.text()), confirmation: "DELETE" }),
});
assert.equal(deleteViewer.status, 303);
assert.equal((await request("/", { headers: { cookie: viewerCookie } })).status, 303, "deleted account session is invalid");

const secondAdminCookie = await login(adminEmail, adminPassword);
const account = await request("/account", { headers: { cookie: adminCookie } });
assert.equal(account.status, 200);
const accountHtml = await account.text();
assert.match(accountHtml, /Change password/);
assert.match(accountHtml, /Display name/);
assert.match(accountHtml, /signs out your other active sessions/);
const updateProfile = await request("/account/profile", {
  method: "POST", headers: { cookie: adminCookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
  body: form({ csrf: csrfFrom(accountHtml), displayName: "Admin User", email: adminEmail, currentPassword: adminPassword }),
});
assert.equal(updateProfile.status, 200);
assert.match(await updateProfile.text(), /Profile updated/);
const changedPassword = "a brand new password 123";
const changePassword = await request("/account/password", {
  method: "POST",
  headers: { cookie: adminCookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
  body: form({ csrf: csrfFrom(accountHtml), currentPassword: adminPassword, newPassword: changedPassword, confirmPassword: changedPassword }),
});
assert.equal(changePassword.status, 200);
assert.match(await changePassword.text(), /other active sessions have been signed out/);
assert.equal((await request("/", { headers: { cookie: adminCookie } })).status, 200, "current session remains active");
const revokedSession = await request("/", { headers: { cookie: secondAdminCookie } });
assert.equal(revokedSession.status, 303);
assert.equal(revokedSession.headers.get("location"), "/login");
await assert.rejects(() => login(adminEmail, adminPassword));
const changedAdminCookie = await login(adminEmail, changedPassword);
assert.equal((await request("/", { headers: { cookie: changedAdminCookie } })).status, 200);

control.close();
await stop(app);

app = start();
await ready(app);
const persistentCookie = await login(adminEmail, changedPassword);
const persistentDashboard = await (await request(`/sites/${alpha.id}`, { headers: { cookie: persistentCookie } })).text();
assert.match(persistentDashboard, /alpha-only/, "events persist after restart");
assert.equal((await request(`/js/${beta.public_key}.js`)).status, 200, "site tracker persists after restart");
await stop(app);

app = start({ RISULTA_TRUST_PROXY_CIDRS: "127.0.0.1/32" });
await ready(app);
const trustedForwardedCookie = await login(adminEmail, changedPassword, { origin: secureBase, "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" });
assert.match(trustedForwardedCookie, /^__Host-risulta_session=/, "trusted forwarding headers enable secure cookies");
await stop(app);
const backupDir = mkdtempSync(`${tmpdir()}/risulta-backups-`);
const backupResult = await command(["backup", backupDir], { DATA_DIR: dir });
assert.equal(backupResult.code, 0, backupResult.errors);
const snapshot = backupResult.output.match(/backup created at (.+)\n/)?.[1];
assert.ok(snapshot, "backup path is reported");
assert.ok(existsSync(`${snapshot}/control.db`));
assert.ok(existsSync(`${snapshot}/sites/${alpha.db_name}`));
const restored = new RisultaDatabase(snapshot);
assert.equal(restored.siteStore(restored.getSiteByKey(alpha.public_key)).analytics(0).summary.pageviews, 2, "backup contains analytics events");
assert.equal(Number(restored.control.prepare("PRAGMA user_version").get().user_version), 3, "control schema version is recorded");
restored.close();


console.log("risulta multi-site self-check OK");
