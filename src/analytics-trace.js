import { asciiJson } from "./util.js";

function queryName(sql, values) {
  if (sql.includes("counted AS")) return "funnels";
  if (sql.includes("configured AS")) return "goals";
  if (sql.includes("WITH marked AS")) return "hourly";
  if (sql.includes("WITH scoped AS")) return "live_sessions";
  if (sql.includes("FROM funnel_steps")) return "funnel_steps";
  if (sql.includes("FROM funnels WHERE")) return "funnel_definitions";
  if (sql.includes("AS covered")) return "rollup_coverage";
  if (sql.includes("analytics_rollup_dimensions")) {
    const dimension = ["path","source","medium","campaign"].indexOf(values[3])>=0 ? values[3] : "dimension";
    return (sql.includes("total_rows") ? "report_" : "acquisition_") + dimension;
  }
  if (sql.includes("analytics_rollup_visitors")) return sql.includes("date(day") ? "historical_daily" : sql.includes("count(DISTINCT") ? "exact_visitors" : "historical_totals";
  if (sql.includes("FROM goals")) return "configuration";
  if (sql.includes("GROUP BY day")) return "live_daily";
  if (sql.includes("GROUP BY hour")) return "live_hourly";
  if (sql.includes("AS pageviews")) return "live_totals";
  if (sql.includes("count(DISTINCT visitor)")) return "current_visitors";
  return "analytics_query";
}

// Trace records omit bound values, identities and credentials.
export function analyticsTrace(database) {
  const started = Date.now();
  const spans = [];
  let dropped = 0;
  const db = {
    exec(sql) { return database.exec(sql); },
    prepare(sql) {
      const before = Date.now();
      let statement = database.prepare(sql);
      let prepareMs = Date.now()-before;
      let bindMs = 0;
      let values = [];
      function execute(method) {
        if (spans.length>=64) { dropped++; return statement[method](); }
        const planStarted = Date.now();
        let plan = [];
        if (method !== "run") {
          try {
            plan = database.prepare("EXPLAIN QUERY PLAN " + sql).bind(...values).all().results.map((row)=>({id:row.id,parent:row.parent,detail:String(row.detail)})).slice(0,64);
          } catch { /* An unavailable query plan must not prevent the original read. */ }
        }
        const planMs = Date.now()-planStarted;
        const at = Date.now();
        const result = statement[method]();
        const executeMs = Date.now()-at;
        spans.push({name:queryName(sql,values),query:sql.replace(/\s+/g," ").slice(0,180),offset_ms:at-started,prepare_ms:prepareMs,bind_ms:bindMs,execute_ms:executeMs,plan_ms:planMs,rows:method==="all" ? result.results.length : method==="first" ? (result ? 1 : 0) : 0,plan});
        prepareMs=0;bindMs=0;
        return result;
      }
      return {
        bind(...args) { values=args;const at=Date.now();statement=statement.bind(...args);bindMs+=Date.now()-at;return this; },
        first() { return execute("first"); },
        all() { return execute("all"); },
        run() { return execute("run"); },
      };
    },
  };
  return {db,finish(serializeMs) {
    let queryMs=0;let planMs=0;
    for (const span of spans) { queryMs+=span.prepare_ms+span.bind_ms+span.execute_ms;planMs+=span.plan_ms; }
    const totalMs=Date.now()-started;
    return {total_ms:totalMs,query_ms:queryMs,plan_ms:planMs,serialize_ms:serializeMs,other_ms:Math.max(0,totalMs-queryMs-planMs-serializeMs),dropped,spans};
  }};
}

export function tracedAnalyticsResponse(payload, trace) {
  const at = Date.now();
  const body = asciiJson(payload);
  const serializeMs = Date.now()-at;
  const timing = trace.finish(serializeMs);
  return new Response(body.slice(0,-1) + ',"trace":' + asciiJson(timing) + "}", {headers:{"content-type":"application/json","cache-control":"no-store","server-timing":"db;dur="+timing.query_ms+", plans;dur="+timing.plan_ms+", serialize;dur="+serializeMs+", app;dur="+timing.other_ms}});
}
