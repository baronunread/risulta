import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { usersPage } from "../src/views.js";
import { csrfValid, csrfValue } from "../src/auth.js";

const admin = { user_id: 1, email: "admin@example.com", role: "admin", csrf: 'token<&"' };
const page = usersPage(admin, [], [], "success");
assert.match(page, /method="post" action="\/api\/backup" data-backup-form/);
assert.match(page, /value="token&lt;&amp;&quot;"/);
assert.match(page, /data-backup-toast role="status" aria-live="polite" aria-atomic="true"><\/div>/);
assert.match(page, /data-backup-feedback>Database backup created/);
assert.match(usersPage(admin, [], [], "failed"), /Database backup failed/);
assert.match(usersPage(admin, [], [], "csrf"), /Reload this page/);
assert.doesNotMatch(usersPage(admin, [], [], "<script>"), /<script>/);

// Exercise the complete browser script with only its DOM and network boundary supplied.
const script = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
const button = { disabled: false };
const feedback = { textContent: "" };
const toast = { textContent: "", className: "" };
let submit;
let request;
let reply;
const timers = [];
const form = {
  action: "https://risulta.example/api/backup",
  elements: { csrf: { value: admin.csrf } },
  querySelector: () => button,
  addEventListener: (_name, handler) => { submit = handler; },
};
runInNewContext(script, {
  document: {
    querySelector: (selector) => ({ "[data-backup-form]": form, "[data-backup-feedback]": feedback, "[data-backup-toast]": toast })[selector],
    querySelectorAll: () => [],
    body: { addEventListener: () => {} },
  },
  URLSearchParams,
  setTimeout: (handler) => { timers.push(handler); return timers.length; },
  clearTimeout: () => {},
  fetch: (url, options) => { request = { url, options }; return reply(); },
});
let prevented = 0;
const event = { preventDefault: () => { prevented++; } };
let resolve;
reply = () => new Promise((done) => { resolve = done; });
const pending = submit(event);
assert.equal(button.disabled, true);
assert.equal(feedback.textContent, "Creating database backup...");
assert.equal(request.url, form.action);
assert.equal(request.options.method, "POST");
assert.equal(request.options.headers.Accept, "application/json");
assert.equal(new URLSearchParams(request.options.body).get("csrf"), admin.csrf);
const originalRequest = request;
await submit(event);
assert.equal(request, originalRequest);
resolve({ ok: true, status: 200, json: async () => ({ ok: true, path: "backups/test.sqlite", bytes: 4096 }) });
await pending;
assert.equal(button.disabled, false);
assert.match(feedback.textContent, /backups\/test.sqlite \(4096 bytes\)/);
assert.equal(toast.textContent, feedback.textContent);
timers.at(-1)();
assert.equal(toast.textContent, "");
assert.match(feedback.textContent, /Copy it off the server/);
for (const [status, message] of [[401, /session has expired/], [403, /Reload this page/], [500, /backup failed/]]) {
  reply = async () => ({ ok: false, status, json: async () => ({ error: "failure" }) });
  await submit(event);
  assert.match(feedback.textContent, message);
  assert.equal(button.disabled, false);
}
reply = async () => { throw new Error("network"); };
await submit(event);
assert.match(feedback.textContent, /Could not confirm/);
assert.equal(button.disabled, false);
reply = async () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } });
await submit(event);
assert.match(feedback.textContent, /Could not confirm/);
assert.equal(button.disabled, false);
assert.ok(prevented >= 7);

// Evaluate the actual registered backup handler without the native D1 runtime.
const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const route = source.slice(source.indexOf('app.post("/api/backup"'), source.indexOf("\napp.get(", source.indexOf('app.post("/api/backup"')));
let handler;
let backups = 0;
let failBackup = false;
let databaseErrors = 0;
runInNewContext(route, {
  SCHEMA_VERSION: 3,
  app: { post: (_path, callback) => { handler = callback; } },
  env: { DB: {
    backup: () => { backups++; if (failBackup) throw new Error("disk"); return { path: "backups/test.sqlite", bytes: 4096 }; },
    prepare: () => ({ first: () => ({ n: 2 }) }),
  } },
  bodyOf: (req) => req.bodyText,
  csrfValid, csrfValue,
  json: (data, status = 200) => new Response(JSON.stringify(data), { status }),
  redirect: (path) => new Response(null, { status: 303, headers: { location: path } }),
  incrementCounter: () => { databaseErrors++; },
  recordBackup: () => {},
});
async function post(role, token, html) {
  const req = new Request("https://risulta.example/api/backup", { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded", accept: html ? "text/html" : "application/json",
  } });
  req.bodyText = new URLSearchParams({ csrf: token }).toString();
  return handler({ get: () => ({ role, csrf: admin.csrf }), req: { raw: req } });
}
assert.equal((await post("viewer", admin.csrf, true)).status, 403);
assert.equal((await post("admin", "wrong", false)).status, 403);
let response = await post("admin", "wrong", true);
assert.equal(response.status, 303);
assert.equal(response.headers.get("location"), "/users?backup=csrf");
assert.equal(backups, 0);
response = await post("admin", admin.csrf, false);
assert.equal(response.status, 200);
const result = await response.json();
assert.equal(result.ok, true);
assert.equal(result.path, "backups/test.sqlite");
assert.equal(result.manifest.tables.users, 2);
assert.equal(result.manifest.schema_version, 3);
assert.equal(result.manifest.tables.analytics_rollup_days, 2);
response = await post("admin", admin.csrf, true);
assert.equal(response.status, 303);
assert.equal(response.headers.get("location"), "/users?backup=success");
failBackup = true;
assert.equal((await post("admin", admin.csrf, false)).status, 500);
response = await post("admin", admin.csrf, true);
assert.equal(response.status, 303);
assert.equal(response.headers.get("location"), "/users?backup=failed");
assert.equal(databaseErrors, 2);
console.log("backup UI OK (markup, browser submission, CSRF, authorization, JSON and HTML outcomes)");
