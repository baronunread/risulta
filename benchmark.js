// A small, reproducible localhost ingest benchmark. Results are machine-specific.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { RisultaDatabase } from "./lib/db.js";
import { trackerFor } from "./lib/tracker.js";

const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 25));
const durationSeconds = Math.max(1, Number(process.env.DURATION || 5));
const dir = mkdtempSync(`${tmpdir()}/risulta-bench-`);
const setup = new RisultaDatabase(dir);
const site = setup.createSite("Benchmark", "bench.example");
setup.close();

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const selected = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(selected));
  });
});
const executable = process.env.RISULTA_BENCH_BINARY || process.execPath;
const app = spawn(executable, process.env.RISULTA_BENCH_BINARY ? [] : ["app.js"], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dir },
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
app.stderr.on("data", (chunk) => { errors += chunk; });
await Promise.race([
  new Promise((resolve) => app.stdout.on("data", (chunk) => { if (String(chunk).includes("risulta on")) resolve(); })),
  new Promise((_, reject) => app.once("exit", (code) => reject(new Error(`Risulta exited ${code}: ${errors}`)))),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Risulta did not start")), 5000)),
]);

const endpoint = `http://127.0.0.1:${port}/api/event/${site.public_key}`;
const body = JSON.stringify({ name: "pageview", domain: site.domain, path: "/benchmark", referrer: "" });
const send = async () => {
  const response = await fetch(endpoint, { method: "POST", body, headers: { "user-agent": "risulta-benchmark" } });
  assert.equal(response.status, 202);
};
for (let index = 0; index < 100; index += 1) await send();

const latencies = [];
let completed = 0;
const started = performance.now();
const deadline = started + durationSeconds * 1000;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (performance.now() < deadline) {
    const requestStarted = performance.now();
    await send();
    latencies.push(performance.now() - requestStarted);
    completed += 1;
  }
}));
const elapsedSeconds = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const percentile = (fraction) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))];
const rss = await new Promise((resolve) => {
  const ps = spawn("ps", ["-o", "rss=", "-p", String(app.pid)]);
  let value = "";
  ps.stdout.on("data", (chunk) => { value += chunk; });
  ps.once("close", () => resolve(Number(value.trim()) * 1024));
});
app.kill("SIGTERM");
const exitCode = await new Promise((resolve) => app.once("exit", resolve));
assert.equal(exitCode, 0, errors);

const tracker = trackerFor(site.public_key);
console.log(JSON.stringify({
  executable: process.env.RISULTA_BENCH_BINARY || "bun app.js",
  concurrency,
  duration_seconds: Number(elapsedSeconds.toFixed(2)),
  completed,
  requests_per_second: Math.round(completed / elapsedSeconds),
  latency_ms: { p50: Number(percentile(.5).toFixed(2)), p95: Number(percentile(.95).toFixed(2)), p99: Number(percentile(.99).toFixed(2)) },
  rss_mb: Number((rss / 1024 / 1024).toFixed(1)),
  tracker_bytes: Buffer.byteLength(tracker),
  tracker_gzip_bytes: gzipSync(tracker).length,
}, null, 2));
