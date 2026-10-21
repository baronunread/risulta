# Changelog

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
