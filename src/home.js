import { siteSlug } from "./sites.ts";
import { escapeHtml, fmtInt } from "./util.js";

function visitorSparkline(site) {
  const days = site.overview.byDay;
  const width = 200;
  const height = 40;
  const inset = 3;
  let max = 0;

  for (let i = 0; i < days.length; i++) {
    max = Math.max(max, Number(days[i].visitors) || 0);
  }

  let path = "";
  let previousX = 0;
  let previousY = 0;
  const step = days.length > 1 ? (width - inset * 2) / (days.length - 1) : 0;
  const coordinate = (value) => Math.round(value * 10) / 10;
  for (let i = 0; i < days.length; i++) {
    const x = inset + i * step;
    const value = Number(days[i].visitors) || 0;
    const y = max ? height - inset - value / max * (height - inset * 2) : height - inset;
    // Horizontal handles join smoothly and keep each segment within its daily values.
    path += i ? " C" + coordinate(previousX + step / 3) + " " + coordinate(previousY) +
      " " + coordinate(x - step / 3) + " " + coordinate(y) + " " + coordinate(x) + " " + coordinate(y)
      : "M" + coordinate(x) + " " + coordinate(y);
    previousX = x;
    previousY = y;
  }

  return '<svg class="home-sparkline" viewBox="0 0 ' + width + " " + height + '" preserveAspectRatio="none" role="img" aria-label="Visitors over the last 7 days">' +
    '<path class="home-sparkline-line" d="' + path + '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    "</svg>";
}

export function homeCards(sites) {
  if (!sites.length) return "";

  return '<table class="home-sites" role="table"><caption class="sr-only">Website traffic over the last 7 days</caption>' +
    '<colgroup><col class="home-column-site"><col class="home-column-total"><col class="home-column-total"><col class="home-column-trend"></colgroup>' +
    '<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Website</th><th scope="col" role="columnheader">Visitors</th>' +
    '<th scope="col" role="columnheader">Pageviews</th><th scope="col" role="columnheader">7-day trend</th></tr></thead><tbody role="rowgroup">' +
    sites.map(function (site) {
      return '<tr class="home-site-row" role="row"><th class="home-site-identity" scope="row" role="rowheader">' +
        '<a class="home-site-link" href="/sites/' + escapeHtml(siteSlug(site)) + '"><span class="home-site-name">' + escapeHtml(site.name) + '</span>' +
        '<span class="home-site-domain">' + escapeHtml(site.domain) + '</span></a></th>' +
        '<td class="home-site-total" role="cell"><span class="home-mobile-label" aria-hidden="true">Visitors</span>' + fmtInt(site.overview.visitors) + '</td>' +
        '<td class="home-site-total" role="cell"><span class="home-mobile-label" aria-hidden="true">Pageviews</span>' + fmtInt(site.overview.pageviews) + '</td>' +
        '<td class="home-site-trend" role="cell"><div class="home-trend-inner">' + visitorSparkline(site) +
        '<span class="home-site-arrow" aria-hidden="true">&rarr;</span></div></td></tr>';
    }).join("") + '</tbody></table>';
}
