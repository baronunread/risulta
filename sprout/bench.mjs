// Dev-only localhost ingest benchmark for the standalone sprout.
// Mirrors ../benchmark.js methodology: free port, warmup, fixed-duration
// hammering at fixed concurrency, RPS + latency percentiles + RSS +
// tracker bytes. Run: bun sprout/bench.mjs (build the host binary first).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 25));
const durationSeconds = Math.max(1, Number(process.env.DURATION || 5));
const dir = mkdtempSync(`${tmpdir()}/sprout-bench-`);
const binary = process.env.SPROUT_BENCH_BINARY || "sprout/dist/risulta-sprout";
const adminEmail = "bench@example.com";
const adminPassword = "benchmark-password-0001";

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const selected = probe.address().port;
    probe.close((error) => (error ? reject(error) : resolve(selected)));
  });
});
const app = spawn(binary, [], {
  env: {
    ...process.env,
    PORT: String(port),
    SB_DATA_DIR: dir,
    // Trust loopback as a proxy so each hammer request can carry a distinct
    // X-Forwarded-For test-net address. The INGEST binding limits per IP
    // (240/60s like production); rotating 512 keys keeps the aggregate
    // quota far above what 5 seconds can spend, so the number measures
    // server capacity, not the throttle.
    SB_TRUSTED_PROXIES: "127.0.0.1",
    RISULTA_ADMIN_EMAIL: adminEmail,
    RISULTA_ADMIN_PASSWORD: adminPassword,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
app.stderr.on("data", (chunk) => {
  errors += chunk;
});
const base = `http://127.0.0.1:${port}`;
const startedAt = performance.now();
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  try {
    const res = await fetch(`${base}/healthz`);
    if (res.status === 200) ready = true;
  } catch {
    await new Promise((r) => setTimeout(r, 10));
  }
}
assert.ok(ready, `sprout did not start: ${errors}`);
const startupMs = Number((performance.now() - startedAt).toFixed(0));

const login = await fetch(`${base}/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const me = await fetch(`${base}/api/session`, { headers: { cookie } });
const csrf = (await me.json()).csrf;
const created = await fetch(`${base}/api/sites`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-csrf-token": csrf, cookie },
  body: JSON.stringify({ name: "Benchmark", domain: "bench.example" }),
});
assert.equal(created.status, 201);
const site = await created.json();

const endpoint = `${base}/api/event/${site.publicKey}`;
const body = JSON.stringify({ name: "pageview", domain: site.domain, path: "/benchmark", referrer: "" });
let keyCounter = 0;
const nextIp = () => {
  const n = keyCounter++;
  return `198.51.100.${n % 256}`;
};
const send = async () => {
  const response = await fetch(endpoint, {
    method: "POST",
    body,
    headers: { "user-agent": "risulta-benchmark", "x-forwarded-for": nextIp() },
  });
  assert.equal(response.status, 202);
};
for (let index = 0; index < 100; index += 1) await send();

const latencies = [];
let completed = 0;
const started = performance.now();
const deadline = started + durationSeconds * 1000;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const requestStarted = performance.now();
      await send();
      latencies.push(performance.now() - requestStarted);
      completed += 1;
    }
  }),
);
const elapsedSeconds = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const percentile = (fraction) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))];
const rss = await new Promise((resolve) => {
  const ps = spawn("ps", ["-o", "rss=", "-p", String(app.pid)]);
  let value = "";
  ps.stdout.on("data", (chunk) => {
    value += chunk;
  });
  ps.once("close", () => resolve(Number(value.trim()) * 1024));
});
const tracker = await (await fetch(`${base}/js/${site.publicKey}.js`)).text();
app.kill("SIGTERM");
await new Promise((resolve) => app.once("exit", resolve));

console.log(
  JSON.stringify(
    {
      executable: binary,
      concurrency,
      duration_seconds: Number(elapsedSeconds.toFixed(2)),
      completed,
      requests_per_second: Math.round(completed / elapsedSeconds),
      latency_ms: {
        p50: Number(percentile(0.5).toFixed(2)),
        p95: Number(percentile(0.95).toFixed(2)),
        p99: Number(percentile(0.99).toFixed(2)),
      },
      rss_mb: Number((rss / 1024 / 1024).toFixed(1)),
      startup_ms: startupMs,
      tracker_bytes: Buffer.byteLength(tracker),
      tracker_gzip_bytes: gzipSync(tracker).length,
    },
    null,
    2,
  ),
);
