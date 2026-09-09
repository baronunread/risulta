# Risulta Sprout: product and feasibility plan

2026-09-09. Planning only. No application implementation, migration or replacement of the existing Risulta installation is authorized by this document.

## Decision

Build a separate experiment for privacy-friendly analytics across the developer's own product sites. The first useful workflow is: add a website, install its tracker, see traffic and conversions, and generate a weekly report. Extend it with traffic-drop alerts and downloadable reports so Sproutboat capabilities solve real product needs.

Keep the current Risulta application intact. A Sproutboat-native port is a runtime adaptation, not a packaging fix: Risulta already has a Bun-compiled standalone binary. Establish whether a smaller native runtime is worth the compatibility work before attempting parity.

- [RISULTA-AUDIT.md](RISULTA-AUDIT.md): current implementation, porting obstacles and alternatives.
- [PLAN.md](PLAN.md): complete application architecture, capability mapping, milestones and verification gates.
- [../APP-IDEAS.md](../APP-IDEAS.md): other useful fullstack products that fit Sproutboat (not Risulta-specific).

## Immediate platform work worth doing first

| Rank | Work | Immediate benefit |
| --- | --- | --- |
| 1 | [CLI #23](https://github.com/baronunread/sproutboat-cli/issues/23), load config without bundling for management commands | Tail/versions/rollback remain fast and usable when local application code is broken. |
| 2 | [CLI #24](https://github.com/baronunread/sproutboat-cli/issues/24), reliable dev rebuilds | Keep the last good app alive; do not lose edits or keep stale configuration. |
| 3 | [CLI #18](https://github.com/baronunread/sproutboat-cli/issues/18), asset-only refresh | CSS/image/frontend builds become visible without native recompilation. |
| 4 | [Platform #148](https://github.com/baronunread/sproutboat/issues/148), safe cache policy | Required before putting authenticated analytics dashboards behind the edge. |
| 5 | [Platform #141](https://github.com/baronunread/sproutboat/issues/141), readiness before activation | A failed executable does not replace a working app. |
| 6 | [Platform #142](https://github.com/baronunread/sproutboat/issues/142), background work independent of HTTP eviction | Cron, queue and alarm work continues without website visitors. Essential for any unattended application. |
| 7 | [Platform #147](https://github.com/baronunread/sproutboat/issues/147), file-backed assets | Small, targeted improvement to frontend delivery allocation pressure. Measure benefit. |

CLI #22 removes onboarding friction but is a larger project. Queue indexes (#25) matter as backlog grows; metrics rollups (platform #32) matter under sustained traffic. Broker consolidation is a later measurement-driven decision. Backups (#139), runtime identity (#140), networking (#143) and queue durability (#144) remain launch gates even when their benefits are less visible during editing.

## Agent assignments

On 2026-09-09, three Terra agents were assigned implementation work in isolated worktrees: CLI #23/#24/#18; platform #142; and platform #141/#148. Assignment is not a completion claim. File-backed assets (#147) remains a follow-up after these correctness and development-loop fixes.

## Local implementation status

The reviewed #142 and #148 changes are integrated into the self-hosted repository. The combined suite passes 146 tests and both TypeScript checks. Timed resources use resident active dispatchers, bounded startup and retry backoff; this is not a durable scheduler and does not replay missed cron ticks.

CLI changes for #23/#24/#18 are integrated locally: management commands read configuration without application source, rebuilds retain the last good process behind a stable local port, and unchanged source/configuration reuses the executable for asset refreshes. Candidate timer dispatch is gated until promotion. Regression tests cover missing source, failed rebuilds and rapid saves. These changes are not published releases.

#141 remains open and unimplemented. The deployed broker starts timer delivery at spawn, so candidate startup cannot safely serve as a readiness check. It needs a coordinated dispatch-gating/promotion protocol between control, edge and broker, plus correctly scoped runtime identity. The local CLI gate alone does not provide that deployed protocol.
