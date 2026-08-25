import { execFileSync } from "node:child_process";

function checkoutVersion() {
  try { return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { encoding: "utf8" }).trim(); }
  catch { return "dev"; }
}

export const VERSION = process.env.RISULTA_VERSION || checkoutVersion();
