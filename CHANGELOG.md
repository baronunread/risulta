# Changelog

## Unreleased

- Runs on the current Sproutboat runtime (sproutboat 0.54, compatibility date 2026-11-18) in the
  standard Workers style: `fetch(request, env, ctx)` and `scheduled(controller, env, ctx)`, D1 calls
  that return Promises, and `db.batch()` for every multi-statement write (D1 has no BEGIN or COMMIT).
- Maintenance (the once-a-minute rollup and backup tick) now runs inside the web process, with a time
  budget, instead of a second process of the same binary. The standalone binary still publishes and
  prunes backup files; `SB_SQLITE_EXCLUSIVE=0` is no longer needed by the app.
- A second entry point, `src/worker.js` (example config: `sproutboat.workers.example.jsonc`), builds the same
  app for a Workers-style host such as Sproutboat Cloud: no native code, backups left to the platform (the
  backup pages and routes are absent there). The self-hosted release is still built from `sproutboat.jsonc`
  and `src/standalone.js`.
- `createRisulta(hooks)` takes one optional hooks object (`docs/hooks.md`): `quota`, `ingestGuard`, `events`,
  `migrations`, `schedule`, with safe defaults and a fixed failure policy, so a program that runs Risulta
  for others depends on this package (`risulta/app`) instead of forking it.
- Data layer: every events, goals, funnels, annotations, rollups and cache query goes through
  `store(env, orgId)`, and users, sessions, sites and read-API keys through `shared(env)`
  (`src/data.js`). Both are the one D1 today. A test runs the whole app with the two as separate
  databases, so no query can join across them.
- New optional settings: `RISULTA_TRACKER_ORIGIN` (the origin the tracker snippet is built from) and
  `RISULTA_TRACKER_HOSTS` (hosts that serve only the tracker, collector and widget routes, everything
  else answers 404). Unset, nothing changes.
- Fixes for the stricter runtime: request bodies are streams (read with `request.text()`), a declared
  secret that is not set throws when read, `crypto.subtle.digest` takes bytes.

No schema change. The slug, widget and annotation tables keep their shape; new databases create the
annotations table without a foreign key to `sites` and without the site-delete cache trigger, because
those two can sit in different stores.

## v0.2.2

- Public widgets no longer show light square corners behind their rounded card
  on dark pages. The widget page declares its color scheme, so browsers keep the
  frame transparent, and `widget.js` rounds the frame to match the card.

No schema change.

## v0.2.1

- The event collector now sends CORS headers on every response, including
  errors, and answers preflight (OPTIONS) requests with 204. Browsers no longer
  report "Failed to fetch" for tracker beacons, and integrations that send
  `application/json` work.
- Rejected events whose domain doesn't match the site are logged with the
  offending hostname only, at most once an hour per site and hostname.
- The README shows how to reserve a public widget's size so embedding pages
  don't shift when it appears.

No schema change: upgrades and downgrades between v0.2.0 and v0.2.1 need no
migration.

## v0.2.0

- Refreshed dashboard, login, notifications and public widget styling.
- Compact workspace website table and font loading without late swaps.
- Guided tracker setup with first-pageview confirmation and troubleshooting.
- Widget size/theme previews, copyable embed code and OS-aware automatic themes.
- Site-owned chart annotations with add, edit and delete controls in Settings.
- Standalone backup restore checks and Linux systemd installer upgrade drills.
- Updated deployment, backup and schema recovery documentation.

### Upgrade note

This release adds schema 7 for annotations. Upgrades preserve existing events,
accounts, site IDs and tracker keys. To downgrade to v0.1.8, restore the paired
pre-upgrade database, executable and configuration. Production maintenance
continues to run entirely from the binary, without external Python workers.
