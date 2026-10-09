# Changelog

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
