// Domain contracts at the SQL and analytics boundaries. Every database call
// returns a Promise, as on Workers D1; only prepare() and bind() are synchronous.
export type SqlValue = string | number | boolean | null;

export interface DatabaseStatement {
  bind(...values: SqlValue[]): DatabaseStatement;
  first<T = Record<string, SqlValue>>(): Promise<T | null>;
  all<T = Record<string, SqlValue>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
}

// Structural subset shared by native D1 and the scoped query/test adapters.
export interface Database {
  prepare(sql: string): DatabaseStatement;
  batch(statements: DatabaseStatement[]): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }[]>;
}

export interface SiteAddress {
  id: number;
  slug?: string | null;
}

export interface TrafficSummary {
  pageviews: number;
  visitors: number;
  visits: number;
}

export interface DailyTraffic extends TrafficSummary {
  day: string;
}

export interface TrafficLabel {
  label: string;
  pageviews: number;
  visitors: number;
}

export interface ReportRow extends TrafficLabel {
  value: number;
}

export type AcquisitionDimension = 'path' | 'source' | 'medium' | 'campaign';
export type ReportSort = 'visitors' | 'pageviews' | 'value';

export interface ReportBounds {
  limit: number;
  offset: number;
  sort: ReportSort;
}

export interface AcquisitionReport extends ReportBounds {
  dimension: AcquisitionDimension;
  filters: Record<string, string>;
  rows: ReportRow[];
  total: number;
}

export interface RollupTraffic {
  summary: TrafficSummary;
  byDay: DailyTraffic[];
}

export interface HourlyTraffic extends TrafficSummary {
  hour: number;
}

export interface GoalResult {
  name: string;
  event_name: string;
  path: string;
  conversions: number;
  unique_conversions: number;
  value: number;
  conversion_rate: number;
}
