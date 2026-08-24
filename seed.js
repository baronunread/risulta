import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { RisultaDatabase } from "./lib/db.js";
import { hashPassword } from "./lib/auth.js";

const dataDir = process.env.RISULTA_SEED_DIR;
if (!dataDir) {
  throw new Error("Set RISULTA_SEED_DIR to an empty directory before seeding demo data.");
}

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
if (readdirSync(dataDir).length) {
  throw new Error("RISULTA_SEED_DIR must be empty to avoid replacing or mixing real analytics data.");
}

const email = "hello@risulta.dev";
const password = process.env.RISULTA_SEED_PASSWORD || "risulta-demo-password";
const database = new RisultaDatabase(dataDir);
database.createUser(email, hashPassword(password), "admin");
const site = database.createSite("Risulta", "risulta.dev");
const store = database.siteStore(site);
const paths = ["/", "/docs", "/pricing", "/changelog", "/install"];
const sources = ["", "https://github.com/baronunread/risulta", "https://news.ycombinator.com", "https://www.google.com"];

function random(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

const now = new Date();
now.setUTCSeconds(0, 0);
for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - dayOffset);
  const visitorCount = 72 + Math.round(32 * random(dayOffset + 1));
  for (let visitor = 0; visitor < visitorCount; visitor += 1) {
    const views = 1 + Math.floor(random(dayOffset * 97 + visitor) * 4);
    for (let view = 0; view < views; view += 1) {
      const hour = (8 + visitor * 3 + view * 5) % 24;
      const minute = Math.floor(random(visitor + view * 13 + dayOffset) * 60);
      store.insert({
        ts: Math.floor(day.getTime() / 1000) + hour * 3600 + minute * 60,
        name: "pageview",
        path: paths[Math.floor(random(visitor * 7 + view + dayOffset) * paths.length)],
        referrer: sources[Math.floor(random(visitor + view * 11) * sources.length)],
        visitor: `demo-${dayOffset}-${visitor}`,
      });
    }
  }
}

for (let visitor = 0; visitor < 14; visitor += 1) {
  store.insert({
    ts: Math.floor(Date.now() / 1000) - visitor * 19,
    name: "pageview",
    path: visitor % 3 === 0 ? "/pricing" : "/",
    referrer: visitor % 4 === 0 ? "https://github.com/baronunread/risulta" : "",
    visitor: `current-${visitor}`,
  });
}

database.close();
console.log(`Seeded ${site.name} at ${dataDir}. Sign in with ${email} and the configured seed password.`);
