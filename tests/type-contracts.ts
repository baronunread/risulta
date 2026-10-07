// Compile-only checks, included by tsc and never bundled into the app.
import type { Database, SqlValue, TrafficSummary } from "../src/types.ts";
import { rollupReport, rollupTraffic } from "../src/rollups.ts";
import { SiteSchema, validate } from "../src/validation.ts";

declare const nativeDatabase: D1Database;
const database: Database = nativeDatabase;
const traffic = rollupTraffic(database, 1, 0, 86400, 86400);
const summary: TrafficSummary = traffic.summary;
const views: number = summary.pageviews;
const input = { name: "Shop", domain: "shop.example.com" };
const result = validate(SiteSchema, input);
declare const untrustedPayload: unknown;
validate(SiteSchema, untrustedPayload);
if (result.ok) {
  const domain: string = result.value.domain;
  void domain;
  // @ts-expect-error Successful validation has no error code.
  void result.code;
} else {
  const code: string = result.code;
  void code;
  // @ts-expect-error Failed validation has no parsed output.
  void result.value;
}
void views;

// @ts-expect-error SQL parameters must be scalar values.
const invalidValue: SqlValue = { site: 1 };
void invalidValue;
// @ts-expect-error Database first() can return null.
const row: TrafficSummary = database.prepare("SELECT * FROM events").first<TrafficSummary>();
void row;
// @ts-expect-error Only supported acquisition dimensions can use rollups.
rollupReport(database, 1, 0, 86400, 86400, "event", { limit: 50, offset: 0, sort: "visitors" });
// @ts-expect-error Report ordering is a bounded column union.
rollupReport(database, 1, 0, 86400, 86400, "path", { limit: 50, offset: 0, sort: "label" });
