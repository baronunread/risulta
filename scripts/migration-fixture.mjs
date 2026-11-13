#!/usr/bin/env bun
// Build a realistic source instance for rehearsing a move: two sites, goals, a
// funnel, notes, a shared widget and N events over 90 days, with rollups built
// the way a long-running instance has them. Usage:
//   bun scripts/migration-fixture.mjs OUT.sqlite [EVENTS=100000]
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { d1 } from "../tests/d1.mjs";
import { ensureReady } from "../src/store.js";
import { runRollups } from "../src/maintenance.js";

const out = process.argv[2];
const total = Number(process.argv[3] || 100000);
if (!out) { console.error("usage: migration-fixture.mjs OUT.sqlite [EVENTS]"); process.exit(1); }
rmSync(out, { force: true });
const sqlite = new Database(out);
sqlite.exec("PRAGMA journal_mode=WAL");
const db = d1(sqlite);
await ensureReady(db, db, {});
const now = Math.floor(Date.now() / 1000);
const day = 86400;
sqlite.exec("PRAGMA foreign_keys=ON");
sqlite.query("INSERT INTO sites (id,name,domain,public_key,slug,created_at) VALUES (1,'Sproutboat','sproutboat.com','82f052fad621762871090faa6472f30c','sproutboat',?),(3,'Risulta','risulta.dev','0a1b2c3d4e5f60718293a4b5c6d7e8f9','risulta',?)").run(now - 90 * day, now - 60 * day);
sqlite.query("INSERT INTO public_widgets (site_id, enabled) VALUES (3, 1)").run();
sqlite.query("INSERT INTO goals (id,site_id,name,event_name,path,created_at) VALUES (1,1,'Signup','signup','',?),(2,1,'Docs read','pageview','/docs/start',?),(3,3,'Install','install','',?)").run(now - 80 * day, now - 80 * day, now - 50 * day);
sqlite.query("INSERT INTO funnels (id,site_id,name,created_at) VALUES (1,1,'Docs to signup',?)").run(now - 80 * day);
sqlite.query("INSERT INTO funnel_steps (funnel_id,position,goal_id) VALUES (1,0,2),(1,1,1)").run();
sqlite.query("INSERT INTO annotations (site_id,ts,text) VALUES (1,?,'Launched the Cloud alpha'),(3,?,'Landing page rewrite')").run(now - 30 * day, now - 14 * day);
const paths = ["/", "/docs/start", "/docs/bindings", "/pricing", "/blog/launch", "/compare/workers", "/東京"];
const sources = ["", "", "Google", "Hacker News", "github.com", "x.com", "Bing"];
const insert = sqlite.query("INSERT INTO events (site_id,ts,name,path,referrer,visitor,source,medium,campaign,content,term,value) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
sqlite.transaction(() => {
  for (let i = 0; i < total; i++) {
    const site = rnd() < 0.7 ? 1 : 3;
    const ts = now - Math.floor(rnd() * 90 * day) - 5;
    const visitor = "v" + Math.floor(rnd() * total / 6).toString(16).padStart(8, "0");
    const roll = rnd();
    const name = roll < 0.03 ? (site === 1 ? "signup" : "install") : "pageview";
    const source = sources[Math.floor(rnd() * sources.length)];
    insert.run(site, ts, name, paths[Math.floor(rnd() * paths.length)], source ? source.toLowerCase().replace(/ /g, "") : "", visitor, source, source ? "referral" : "", roll < 0.1 ? "launch" : "", "", "", name === "signup" ? 1 : null);
  }
  sqlite.query("INSERT INTO site_salts (site_id,day,value) VALUES (1,date('now'),'salt-one-0123456789'),(3,date('now'),'salt-three-0123456789')").run();
})();
let built = 0;
for (let n = 1; n > 0;) { n = await runRollups(db, db, now, 100); built += n; }
console.log(`fixture ${out}: ${total} events, ${built} rollup days built`);
sqlite.close();
