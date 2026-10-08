// Isolated benchmark entry point, never included in the production build.
import { runRollups, runScheduledBackup } from "../../src/maintenance.js";
import { backupFiles } from "../../src/backup-files.js";
import { exitMaintenanceProcess } from "../../src/native-workers.js";
import { ensureReady } from "../../src/store.js";
import { ensureBackupSchema } from "../../src/backups.js";

async function measure() {
  try {
    ensureBackupSchema(env.DB);
    await ensureReady(env.DB);
    if (env.BENCH_MODE === "initialize") {
      console.log(JSON.stringify({ result: "initialized" }));
      exitMaintenanceProcess("0");
      return;
    }
    const now = Number(env.BENCH_NOW);
    const result = env.BENCH_MODE === "backup" ? runScheduledBackup(env.DB, backupFiles, now) : runRollups(env.DB, now, Number(env.BENCH_DAYS));
    console.log(JSON.stringify({ result }));
    exitMaintenanceProcess("0");
  } catch (error) {
    console.error(String(error));
    exitMaintenanceProcess("1");
  }
}
setTimeout(measure, 0);
export default { fetch() { return new Response("Benchmark process", { status: 503 }); } };
