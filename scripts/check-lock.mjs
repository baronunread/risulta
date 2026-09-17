import { readFileSync } from "fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = readFileSync("bun.lock", "utf8");
const ver = pkg.dependencies?.sproutboat || pkg.devDependencies?.sproutboat;
if (!lock.includes(ver)) {
  console.error(`bun.lock out of sync: package.json has ${ver}, lockfile doesn't match`);
  process.exit(1);
}
console.log("bun.lock is in sync");
