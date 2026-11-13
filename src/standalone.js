// Standalone entry: the same app plus the one native capability the binary has,
// publishing and pruning backup files. This is what the self-hosted release builds.
import { createRisulta } from "./index.js";
import { backupFiles } from "./backup-files.js";

export default createRisulta({ backupFiles });
