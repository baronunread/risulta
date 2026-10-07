import { siteSlug } from "./sites.js";
import { escapeHtml, fmtInt } from "./util.js";

function visitorSparkline(site) {
  const days = site.overview.byDay;
  const width = 144;
  const height = 36;
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

  return '<svg class="home-sparkline" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="Visitors over the last 7 days">' +
    '<path class="home-sparkline-line" d="' + path + '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
    "</svg>";
}

export function homeCards(sites) {
  if (!sites.length) return "";

  return '<ol class="home-sites">' + sites.map(function (site) {
    return '<li><a class="home-site-card" href="/sites/' + escapeHtml(siteSlug(site)) + '">' +
      '<span class="home-site-identity"><strong class="home-site-name" title="' + escapeHtml(site.name) + '">' + escapeHtml(site.name) + '</strong>' +
      '<span class="home-site-domain" title="' + escapeHtml(site.domain) + '">' + escapeHtml(site.domain) + '</span></span>' +
      '<span class="home-site-arrow" aria-hidden="true">&rarr;</span>' +
      '<span class="home-site-stats" aria-label="Last 7 days">' +
      '<span class="home-site-stat"><strong>' + fmtInt(site.overview.visitors) + '</strong><span>visitors</span></span>' +
      '<span class="home-site-stat"><strong>' + fmtInt(site.overview.pageviews) + '</strong><span>pageviews</span></span>' +
      visitorSparkline(site) +
      '</span></a></li>';
  }).join("") + "</ol>";
}
