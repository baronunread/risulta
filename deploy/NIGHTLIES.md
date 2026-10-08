# Release channels and updates

Stable remains the default. Nightlies are opt-in GitHub prereleases built
from a specific commit, with permanent tags such as
`nightly-20261006-0123456789ab`. Both Linux x64 and arm64 artifacts must
pass lock checks, lint, unit tests, compile checks, seeding and runtime
integration tests before the release is published.

## Update an existing server

Download the installer to a file so arguments work consistently:

```sh
curl -fsSL https://raw.githubusercontent.com/baronunread/risulta/main/deploy/install.sh \
  -o install.sh
sudo sh install.sh --update --channel nightly
```

Later updates use the saved channel:

```sh
sudo sh install.sh --update
```

Switch back to the latest stable release:

```sh
sudo sh install.sh --update --channel stable
```

Install a particular release once, without changing the saved channel:

```sh
sudo sh install.sh --update --version nightly-20261006-0123456789ab
```

`--channel` and `--version` cannot be combined. New installations can also
select either option, but retain the interactive first-run setup. An exact
nightly version on a fresh installation does not opt into future nightlies;
the default channel stays stable.

The installer requires Linux, systemd, curl and awk for release JSON
parsing; updates also require `flock` from util-linux. Update mode needs an
existing service, configuration and database. It does not prompt, install
Caddy, rewrite the environment file, or change the service definition. It
uses the saved port and data directory, including custom data locations.

The channel, installed tag, commit and repository are saved in
`/etc/risulta-sprout/release.env`. Older stable releases without `release.json`
remain installable, with their commit recorded as `unknown`. New nightlies
must include matching metadata. The installer resolves an exact tag first,
then fetches its binary and checksum from the same release.

## Backup and recovery

Before replacing the executable, the update verifies its checksum, stages
it on the destination filesystem and preserves the current executable and
configuration. It stops the service to copy the data consistently into a
unique directory beneath `/var/backups/risulta-sprout/`, then replaces the
executable atomically and checks service readiness. A file lock prevents
overlapping updates. An identical installed checksum skips replacement,
backup and restart, while still recording an explicit channel selection.

Recovery directories contain `risulta-sprout`, `risulta-sprout.env`,
`data/`, and the prior `release.env` when available. Protect these directories:
the data and environment can contain credentials. Copy important backups
off the server and manage retention yourself.

If backup creation fails before replacement, the installer attempts to
restart the previous executable. If the new executable fails readiness,
the installer stops it, leaves the saved channel/version unchanged, and
prints the recovery directory. It does not automatically restore the database.

Review the release's schema notes before downgrading. For an incompatible
schema, stop the service and restore the matching data, executable and
configuration from the same recovery directory, preserving ownership.
Restoring older data discards activity collected since that backup. If the
schema remains compatible, an exact-version install can replace only the
executable while preserving current data. The first nightly adds `read_api_keys`, `backup_settings`, `backup_history`
and a covering analytics index. These additions preserve the existing tables
and event data; earlier binaries ignore the new tables. Backup scheduling and rollup processing run in a separate process of the same executable, with no Python dependency. Older external worker timers are disabled when upgrading to a built-in maintenance release. Releases that require external workers must use their original installer.

The readiness check confirms the service and `/healthz`; the release workflow
also exercises login, authorization and analytics against disposable state.
These are distinct checks. The installer does not know existing administrator
passwords and cannot prove a real user's login after an update.

## Publishing

The Release workflow retains normal `v*` tag releases. At 03:23 UTC daily,
it resolves `main` and publishes a nightly only when the commit differs from
the latest published nightly. Manual dispatch also supports a nightly:

```sh
gh workflow run release.yml --ref main -f channel=nightly -f ref=main
```

Nightlies never become GitHub's stable latest release. The workflow uploads
both architectures, installer, metadata and checksums to a draft, verifies
the full asset inventory, then publishes the complete release. Existing
published nightly tags are skipped; stranded drafts require review rather
than asset replacement. The lockfile controls dependencies, so nightlies do
not automatically upgrade the compiler or application packages.

Publishing a nightly does not update servers. This rollout enables manual
updates only; no automatic-update timer is installed.
