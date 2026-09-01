# Changelog

All notable changes to Risulta are documented in this file.

## Unreleased

### Changed

- Clarified privacy-preserving visitor metrics in the dashboard and README.
  Multi-day reports now label the metric as unique visitor-days, because the
  anonymous identifier changes at midnight UTC.

## v0.3.3, 2026-08-25

### Added

- Structured JSON request and error diagnostics, configurable logging, and a
  loopback-only metrics endpoint.

### Fixed

- Reserved scrollbar space to prevent layout shift.

## v0.3.2, 2026-08-25

### Changed

- Polished the site-switcher chevron interaction and alignment.

## v0.3.1, 2026-08-25

### Added

- Embedded the website-settings icon in the compiled binary.

### Changed

- Refined site navigation, report pages, website selection controls, and the
  release footer and tracker snippet.

## v0.3.0, 2026-08-25

### Added

- Theme-aware favicons, version footer, account-profile editing, account
  deletion, local avatar previews, and copyable tracker snippets.
- Dedicated top-pages and top-sources report pages.
- Seeded multi-site dashboard data for local development.

### Changed

- Refreshed dashboard, chart, user-management, and site-switcher UI.
- Derived release versions from build metadata and made release-tag checks
  exact.
- Removed the legacy Hutch integration.

## v0.2.1, 2026-08-25

### Fixed

- Checked out the release-manifest generator before publishing a release.

## v0.2.0, 2026-08-25

### Added

- Online SQLite backups through the Risulta binary, with restore guidance.
- Versioned, transactional migrations for control and site databases.
- Password changes that revoke other sessions.
- Development seed data and dashboard chart data.

### Changed

- Added build-version metadata to releases.
- Replaced the trusted-proxy switch with validated IPv4 and IPv6 CIDR support.
- Added bounded per-IP analytics-ingest rate limiting.

## v0.1.1, 2026-08-24

### Changed

- Improved the dashboard and replaced remote avatar dependencies with local
  generated avatars.
- Installed build dependencies before release builds.

## v0.1.0, 2026-08-24

### Added

- Initial release of self-hosted, privacy-friendly multi-site analytics.
- Cookie-free pageview and SPA navigation tracking, daily anonymous visitor
  hashes, referrer reporting, dashboards, user roles, and SQLite storage.
