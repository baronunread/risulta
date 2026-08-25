import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RisultaDatabase } from "./lib/db.js";
import { hashPassword } from "./lib/auth.js";

const dataDir = process.env.RISULTA_SEED_DIR;
if (!dataDir) {
  throw new Error("Set RISULTA_SEED_DIR before seeding demo data.");
}

mkdirSync(dataDir, { recursive: true });
for (const file of ["control.db", "control.db-wal", "control.db-shm"]) rmSync(join(dataDir, file), { force: true });
rmSync(join(dataDir, "sites"), { force: true, recursive: true });

const email = "hello@risulta.dev";
const password = process.env.RISULTA_SEED_PASSWORD || "risulta-demo-password";
const database = new RisultaDatabase(dataDir);
database.createUser(email, hashPassword(password), "admin");
const sites = [
  ["Risulta", "risulta.dev"],
  ["Marketing", "marketing.risulta.dev"],
  ["Docs", "docs.risulta.dev"],
].map(([name, domain]) => database.createSite(name, domain));
const paths = ["/", "/docs", "/pricing", "/changelog", "/install"];
const sources = ["", "https://github.com/baronunread/risulta", "https://news.ycombinator.com", "https://www.google.com"];

function random(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

const now = new Date();
now.setUTCSeconds(0, 0);
for (const [siteIndex, site] of sites.entries()) {
  const store = database.siteStore(site);
  for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(now);
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() - dayOffset);
    const visitorCount = 72 + siteIndex * 18 + Math.round(32 * random(dayOffset + siteIndex + 1));
    for (let visitor = 0; visitor < visitorCount; visitor += 1) {
      const views = 1 + Math.floor(random(dayOffset * 97 + visitor + siteIndex * 31) * 4);
      for (let view = 0; view < views; view += 1) {
        const hour = (8 + visitor * 3 + view * 5 + siteIndex * 2) % 24;
        const minute = Math.floor(random(visitor + view * 13 + dayOffset + siteIndex * 17) * 60);
        store.insert({
          ts: Math.floor(day.getTime() / 1000) + hour * 3600 + minute * 60,
          name: "pageview",
          path: paths[Math.floor(random(visitor * 7 + view + dayOffset + siteIndex) * paths.length)],
          referrer: sources[Math.floor(random(visitor + view * 11 + siteIndex) * sources.length)],
          visitor: `demo-${siteIndex}-${dayOffset}-${visitor}`,
        });
      }
    }
  }

  for (let visitor = 0; visitor < 14 + siteIndex * 4; visitor += 1) {
    store.insert({
      ts: Math.floor(Date.now() / 1000) - visitor * 19,
      name: "pageview",
      path: visitor % 3 === 0 ? "/pricing" : "/",
      referrer: visitor % 4 === 0 ? "https://github.com/baronunread/risulta" : "",
      visitor: `current-${siteIndex}-${visitor}`,
    });
  }
}

database.close();
console.log(`Seeded ${sites.length} websites at ${dataDir}. Sign in with ${email} and the configured seed password.`);
