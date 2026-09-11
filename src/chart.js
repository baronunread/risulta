// SVG traffic chart, ported from lib/views.js to runtime-safe constructs
// (no Intl, no Array.from, no padStart, no optional chaining, and no
// `new Date().toISOString()`, which livelocks the runtime in async turns;
// day labels come from dayStringFromMs in util.js).
import { dayStringFromMs, escapeHtml, fmtInt } from "./util.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function dayLabel(isoDay) {
  const parts = String(isoDay).split("-");
  return MONTHS[Number(parts[1]) - 1] + " " + Number(parts[2]);
}

export function hourLabel(hour) {
  const h = Number(hour);
  const pad = h < 10 ? "0" + h : "" + h;
  return pad + ":00";
}

// Fill trailing UTC days so the chart never has gaps.
export function dateSeries(days, rows) {
  const values = {};
  for (let i = 0; i < rows.length; i++) values[rows[i].day] = rows[i];
  const out = [];
  const todayStart = Math.floor(Date.now() / 86400000) * 86400000;
  for (let offset = days - 1; offset >= 0; offset--) {
    const day = dayStringFromMs(todayStart - offset * 86400000);
    out.push(values[day] || { day, pageviews: 0, visitors: 0, visits: 0 });
  }
  return out;
}

export function hourSeries(rows) {
  const values = {};
  for (let i = 0; i < rows.length; i++) values[Number(rows[i].hour)] = rows[i];
  const out = [];
  for (let hour = 0; hour < 24; hour++) {
    const row = values[hour] || { pageviews: 0, visitors: 0, visits: 0 };
    out.push({ hour, pageviews: row.pageviews, visitors: row.visitors, visits: row.visits });
  }
  return out;
}

export function chartPointLabel(point) {
  if (point.hour === undefined) return dayLabel(point.day);
  return hourLabel(point.hour) + " UTC";
}

export function chart(series, metric, metricLabel) {
  const width = 960;
  const height = 248;
  const top = 16;
  const bottom = 30;
  let max = 1;
  for (let i = 0; i < series.length; i++) max = Math.max(max, Number(series[i][metric]));
  const x = function (index) {
    return series.length === 1 ? width / 2 : (index / (series.length - 1)) * width;
  };
  const y = function (value) {
    return top + (1 - Number(value) / max) * (height - top - bottom);
  };
  const xs = [];
  const ys = [];
  for (let i = 0; i < series.length; i++) {
    xs.push(x(i));
    ys.push(y(series[i][metric]));
  }
  let line = "";
  for (let i = 0; i < series.length; i++) {
    if (!i) {
      line += "M" + xs[i].toFixed(1) + "," + ys[i].toFixed(1);
      continue;
    }
    const beforeX = i >= 2 ? xs[i - 2] : xs[i - 1];
    const beforeY = i >= 2 ? ys[i - 2] : ys[i - 1];
    const afterX = i + 1 < series.length ? xs[i + 1] : xs[i];
    const afterY = i + 1 < series.length ? ys[i + 1] : ys[i];
    const segmentMin = Math.min(ys[i - 1], ys[i]);
    const segmentMax = Math.max(ys[i - 1], ys[i]);
    const clampY = function (value) {
      return Math.max(segmentMin, Math.min(segmentMax, value));
    };
    const c1x = xs[i - 1] + (xs[i] - beforeX) / 6;
    const c1y = clampY(ys[i - 1] + (ys[i] - beforeY) / 6);
    const c2x = xs[i] - (afterX - xs[i - 1]) / 6;
    const c2y = clampY(ys[i] - (afterY - ys[i - 1]) / 6);
    line += "C" + c1x.toFixed(1) + "," + c1y.toFixed(1) + " " + c2x.toFixed(1) + "," + c2y.toFixed(1) + " " + xs[i].toFixed(1) + "," + ys[i].toFixed(1);
  }
  const area = line + " L" + width + "," + (height - bottom) + " L0," + (height - bottom) + " Z";
  const ticks = [];
  for (let i = 0; i < series.length; i++) {
    if (series.length <= 7 || i % Math.ceil(series.length / 6) === 0 || i === series.length - 1) ticks.push(i);
  }
  let circles = "";
  for (let i = 0; i < series.length; i++) {
    const label = chartPointLabel(series[i]) + ": " + fmtInt(series[i][metric]) + " " + metricLabel.toLowerCase();
    circles += '<circle class="chart-point" cx="' + xs[i] + '" cy="' + ys[i] + '" r="5" tabindex="0" data-value="' + escapeHtml(label) + '"><title>' + escapeHtml(label) + "</title></circle>";
  }
  let tickLabels = "";
  for (let t = 0; t < ticks.length; t++) {
    const i = ticks[t];
    const anchor = i === 0 ? "start" : i === series.length - 1 ? "end" : "middle";
    const text = chartPointLabel(series[i]).replace(" UTC", "");
    tickLabels += '<text x="' + xs[i] + '" y="' + (height - 7) + '" text-anchor="' + anchor + '">' + escapeHtml(text) + "</text>";
  }
  return '<svg class="chart" viewBox="0 0 ' + width + " " + height + '" role="img" aria-labelledby="chart-title chart-desc">' +
    '<title id="chart-title">' + escapeHtml(metricLabel) + " over the selected period</title>" +
    '<desc id="chart-desc">A line chart with a peak of ' + fmtInt(max) + " " + escapeHtml(metricLabel.toLowerCase()) + " in one interval.</desc>" +
    '<defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop stop-color="currentColor" stop-opacity=".16"/>' +
    '<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>' +
    '<g class="grid" aria-hidden="true"><path d="M0 ' + top + "H" + width + "M0 " + (height - bottom + top) / 2 + "H" + width + "M0 " + (height - bottom) + 'H' + width + '"/></g>' +
    '<polygon points="' + area + '" fill="url(#area)" aria-hidden="true"/>' +
    '<path d="' + line + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" aria-hidden="true"/>' +
    circles + tickLabels + "</svg>";
}
