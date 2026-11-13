# Extension hooks

`createRisulta(hooks)` (`src/index.js`, exported as `risulta/app`) returns the Workers module
`{ fetch, scheduled }`. The argument is one optional object. Without it you get the plain
self-hosted app, which is what `src/standalone.js` and `src/worker.js` build.

A program that runs Risulta for other people depends on this package, imports `createRisulta`,
passes its hooks and keeps its own deploy config. It never patches app code: anything it needs
becomes a hook or an option here, with a safe default.

```js
import { createRisulta } from "risulta/app";

export default createRisulta({
  hooksVersion: 1,
  quota: { limits: async (orgId) => ({ sites: 10 }) },
  ingestGuard: (site, { request }) => "allow",
});
```

Static assets are in `risulta/public/*`; point `assets.directory` at that folder of the installed
package (or copy it in a prebuild step).

## What exists

| Hook | Shape | Default | Failure policy |
| --- | --- | --- | --- |
| `hooksVersion` | `1` | 1 | a different number makes `createRisulta` throw |
| `backupFiles` | file operations that publish and prune backup files | none (the standalone entry supplies it) | n/a |
| `quota` | `{ limits(orgId, env) -> { sites, pageviews, members, readKeys, retentionDays, moveWindow, moveMaxEvents } }`, `null` is unlimited | unlimited | fails open. Core enforces `sites` (a new website, and the websites a move brings in) and passes `retentionDays`, `moveWindow` and `moveMaxEvents` to the move feature |
| `ingestGuard` | `(site, { request }) -> "allow" \| "drop"`, synchronous | allow | fails open. A drop is answered `202` and stores nothing |
| `events` | `{ siteCreated({ orgId, site }) }` | none | the error is logged and ignored |
| `migrations` | `[{ version, sql }]`, strictly increasing integers | none | the host's tables, run after core's own, in their own ledger `host_migrations`. Each version is one batch with its ledger row, so a failure is retried whole |
| `schedule` | `({ env, now, deadlineMs }) -> void`, runs inside the time-budgeted tick | none | the error is logged, the tick goes on |
| `blobs` | `(env) -> { put(key, text), get(key), delete(key) }`, keys chosen by the server (a function of `env`: the host's storage is a binding) | rows in the shared database | where bundle parts of a move or import wait |

Unknown names are refused, so a misspelled hook is not silently ignored.

## Accepted, not used yet

`jobs` (how a host wakes background steps: moves are driven by the tick and the page poll today), `billing`, `onSignup`, `mailer` and `operator` are accepted and carried on the resolved hooks
object. Nothing in core calls them yet, because the features they belong to (accounts and
signup, e-mail, billing state, operator routes, queue-woken steps) are not in core. Quota values other than `sites`, `retentionDays` and the move numbers
and the other `events` names are in the same position.

Core runs one app per isolate: the hooks are module state set by `createRisulta`.
