// Workers entry: the standard module shape, no native code, backups left to the
// host. This is the generic build for a Workers-style host (see
// sproutboat.workers.example.jsonc). A host that needs more than the defaults
// wraps the app itself: `import { createRisulta } from "risulta/app"` and passes
// its hooks (docs/hooks.md), from its own repository and its own config.
import { createRisulta } from "./index.js";

export default createRisulta();
