# mrkr comparison and Risulta feature priorities

Reviewed 2026-10-06 against mrkr's public site and Risulta's current source and open GitHub issues. Competitor capabilities below are vendor claims, not independent runtime verification.

## Positioning

mrkr sells hosted privacy-focused analytics with product analytics included. Its published plans are $5/month for 100K pageviews, $14 for 300K, and $29 for 1M, with a $1 introductory 14 days and pageview overages. Its pitch connects acquisition to conversions and revenue rather than simply counting traffic.

Risulta's advantage is operational independence: one self-hosted binary, local SQLite, no external database, cookieless tracking, and AGPL source. Preserve that advantage while making the existing data more useful.

Sources: [mrkr homepage and pricing](https://mrkr.app/), [feature inventory and limitations](https://mrkr.app/features), [recent releases](https://mrkr.app/changelog), [MCP documentation](https://mrkr.app/docs/integrations/mcp).

## Current overlap and gaps

| Capability | Risulta today | Useful next step |
| --- | --- | --- |
| Cookieless tracking | Site-specific daily salts; no visitor cookies | Keep the daily identity boundary explicit in journeys and funnels |
| Live analytics | Current visitors and dashboard polling every five seconds | Improve inspection before replacing polling |
| Acquisition | Five UTM fields, hostname referrers, source/campaign reports | Session-entry attribution, channels, and conversion breakdowns |
| Custom events | `window.risulta.track(name, value)` and public ingest endpoint | Bounded properties, documented semantics, stable event ordering |
| Goals and funnels | Goal values and ordered funnel steps; bounded event scans | Session journeys and drilldown from funnel drop-off |
| Revenue | Numeric event values summed for goals | Currency-aware revenue by source/campaign; purchase deduplication |
| Reports and exports | Filtered, sortable, paginated HTML/JSON/CSV reports | Shared dashboard filters and stable external API credentials |
| Bot and AI traffic | Ingest validation and rate limits, no classifier | Explainable bot exclusions and AI referral categories |
| Engagement and vitals | Session calculation, no dedicated vitals capture | Foreground engagement first, then optional sampled field vitals |
| AI assistant access | Session-authenticated stats/report endpoints | Scoped read API first, then a small read-only MCP surface |
| First-party collection | Self-hosting allows site-controlled deployment | Document same-origin reverse proxy configuration and verification |
| Session replay | Absent | Defer pending a separate privacy, retention, and binary-size design |

mrkr publishes limits worth learning from: revenue is last-click within a session, cross-day funnels require cookie mode, and crawler reporting needs a backend beacon. Its feature inventory says there is no supported backend event API. Its homepage says exports currently require contacting support. Risulta can differentiate with documented server events and self-service exports.

## Recommended order

1. **Session journeys ([#54](https://github.com/baronunread/risulta/issues/54)).** Reuse stored events and the existing 30-minute session boundary. Bound queries and pagination, order equal timestamps by event ID, and explain that identities rotate daily. Add funnel drop-off inspection after the journey view exists.
2. **Finish acquisition and revenue ([#31](https://github.com/baronunread/risulta/issues/31), [#50](https://github.com/baronunread/risulta/issues/50)).** Define session-entry source propagation before attributing purchases. Add bounded event properties, currency and purchase IDs, deduplicate purchases, and report conversions/revenue by source, campaign, and landing page. Never combine currencies into one total without an explicit conversion policy. Stripe integration can follow a reliable server-event path.
3. **Clean traffic and classify AI referrals.** Start with recognizable user agents and referrer hosts, separate excluded traffic from human totals, expose reasons, and allow site exclusions. Keep AI answer referrals distinct from crawlers; browser tracking cannot observe crawlers that never execute JavaScript. Avoid headless-browser or datacenter heuristics as unconditional rejection rules.
4. **Read API, then MCP ([#51](https://github.com/baronunread/risulta/issues/51)).** Add revocable site-scoped credentials, query limits and response documentation to existing queries. Build read-only overview, breakdown, realtime and funnel tools on top. Configuration writes and remote OAuth should be separate milestones.
5. **Small product improvements.** Expose existing backups ([#47](https://github.com/baronunread/risulta/issues/47)), add chart annotations ([#53](https://github.com/baronunread/risulta/issues/53)), and opt-in live badges ([#52](https://github.com/baronunread/risulta/issues/52)). Document first-party proxy setup before adding provisioning infrastructure.
6. **Engagement and Web Vitals.** Align foreground timing with [#32](https://github.com/baronunread/risulta/issues/32), then add optional sampled LCP/CLS/INP measurements and p75 summaries. Set retention and storage budgets before introducing heartbeat traffic.

Defer replay, persistent visitor identity, a hosted proxy service, and a broad MCP write API. Each expands the privacy or operational contract more than the first priorities. Geo lookup ([#48](https://github.com/baronunread/risulta/issues/48)) also requires a plan for the external database's distribution and updates.

## Open-issue review

There are 28 open issues at review time. Several refer to the former Bun architecture and need their acceptance criteria reconciled with the standalone implementation.

- **Partially implemented:** [#35 reports/API](https://github.com/baronunread/risulta/issues/35) already has filtered HTML/JSON/CSV reports, sorting, pagination, and session-authenticated APIs; dashboard-wide filtering, additional dimensions and documentation still need review. [#31 acquisition](https://github.com/baronunread/risulta/issues/31) already captures UTMs, but session attribution and channel/conversion reporting remain. [#50 events](https://github.com/baronunread/risulta/issues/50) already supports names and values, but arbitrary properties remain absent.
- **Operations acceptance still needs review:** [#1 backups](https://github.com/baronunread/risulta/issues/1) has a protected snapshot API and manifest, but its restore-drill and manifest requirements go further. [#3 account lifecycle](https://github.com/baronunread/risulta/issues/3) already has password changes, but recovery and full revocation scope need checking. [#4 proxy trust](https://github.com/baronunread/risulta/issues/4) now uses the runtime's trusted-proxy setting; review CIDR and malformed-chain cases. [#6 overload](https://github.com/baronunread/risulta/issues/6) has ingest throttling, but its concurrency, fairness and memory requirements are broader.
- **Toolchain follow-up:** [#44 runtime workarounds](https://github.com/baronunread/risulta/issues/44) references upstream issues 168 and 169, both now closed. Probe their original reproductions on 0.15.0 before deleting workarounds; closure alone is insufficient evidence. Keep [#42 SSE](https://github.com/baronunread/risulta/issues/42) separate from this upgrade.
- **Older UI issues:** [#15 tracker settings](https://github.com/baronunread/risulta/issues/15) already has clipboard feedback in the source, but toggle/accessibility/CSP acceptance needs a browser check. [#12 compact cards](https://github.com/baronunread/risulta/issues/12) needs visual review before closure. [#45 Tailwind](https://github.com/baronunread/risulta/issues/45) identifies no concrete current need.
- **Foundations to retain:** #2 migrations, #7 capacity targets, #8 reproducible benchmarks, #9 rollups/retention, #10 summary cache, #43 historical imports, and #49 TOTP remain useful independently of competitor parity. #11 containers is optional packaging; #34 audience dimensions should align with #48 geo and the privacy contract.

No issues were edited or closed during this review. The implementation priorities above are proposals, not shipped features.
