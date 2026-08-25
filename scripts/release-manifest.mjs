import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, directory] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || "") || !directory) throw new Error("Usage: release-manifest.mjs <vX.Y.Z> <directory>");

const assets = {};
for (const name of readdirSync(directory).filter((entry) => entry.startsWith("risulta-linux-") && entry.endsWith(".sha256"))) {
  const artifact = name.slice(0, -7);
  assets[artifact] = { sha256: readFileSync(join(directory, name), "utf8").trim().split(/\s+/)[0] };
}
if (!Object.keys(assets).length) throw new Error("No release checksums found");
writeFileSync(join(directory, "risulta-release.json"), `${JSON.stringify({ version, breaking: false, assets }, null, 2)}\n`);
