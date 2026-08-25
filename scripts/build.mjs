import { execFileSync } from "node:child_process";

const fallbackVersion = () => {
  try { return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).trim(); }
  catch { return "dev"; }
};
const version = process.env.RISULTA_VERSION || fallbackVersion();
const target = process.env.RISULTA_BUILD_TARGET;
const outfile = process.env.RISULTA_BUILD_OUTFILE || "risulta";
const args = ["build", "--compile", "--minify", "--no-compile-autoload-dotenv", "--define", `process.env.RISULTA_VERSION=${JSON.stringify(version)}`, "app.js", "--outfile", outfile];
if (target) args.push(`--target=${target}`);
execFileSync("bun", args, { stdio: "inherit" });
