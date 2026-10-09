import { siteSlug } from "./sites.ts";
// Server-rendered pages. Markup follows lib/views.js class names so the
// same stylesheet renders both apps.
import { homeCards } from "./home.js";
import { chart, dateSeries, hourSeries } from "./chart.js";
import { avatarFor } from "./avatar.js";
import { dayStringFromMs, escapeHtml, fmtInt } from "./util.js";

function oneDecimal(value) {
  const tenths = Math.round(Math.abs(Number(value)) * 10);
  return (value < 0 && tenths ? "-" : "") + Math.floor(tenths / 10) + "." + tenths % 10;
}

export function trackerFor(publicKey) {
  return (
    "/*! Risulta tracker - MIT */(()=>{let l=\"\";const s=document.currentScript,e=new URL(\"/api/event/" +
    publicKey +
    "\",s.src).href,p=(n,v)=>fetch(e,{method:\"POST\",mode:\"cors\",keepalive:true,headers:{\"Content-Type\":\"text/plain\"},body:JSON.stringify({name:n,path:location.pathname+location.search,referrer:document.referrer,domain:location.hostname,value:v})}).catch(()=>{}),f=()=>{const p=location.pathname+location.search;if(p===l)return;l=p;return(window.risulta??={}).track(\"pageview\")};for(const k of[\"pushState\",\"replaceState\"]){const o=history[k];history[k]=function(){const r=o.apply(this,arguments);f();return r}}(window.risulta??={}).track=p;addEventListener(\"popstate\",f);addEventListener(\"pageshow\",e=>{if(e.persisted){l=\"\";f()}});f()})();"
  );
}

const MARK = '<svg class="mark" width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">' +
  '<rect x="1" y="1" width="30" height="30" rx="8" fill="var(--bg)" stroke="var(--line)" stroke-width="2"/>' +
  '<path fill="var(--fg)" d="M9 23C10 15 16 9 25 8C22 14 15 19 9 23Z"/>' +
  '<path d="M10.5 21.3C14 17 18 13 21.8 10" fill="none" stroke="var(--bg)" stroke-width="1.3" stroke-linecap="round"/></svg>';
function topbar(user, site, sites) {
  const switcher = site
    ? '<div class="site-context">' + (sites.length > 1
      ? '<details class="site-switcher"><summary class="site-switcher-trigger"><span>' + escapeHtml(site.name) +
        '</span><span class="select-chevron" aria-hidden="true"></span></summary><div class="site-switcher-menu">' +
        sites.map((s) => '<a href="/sites/' + siteSlug(s) + '"' + (s.id === site.id ? ' aria-current="page"' : "") + "><span>" + (s.id === site.id ? "&#10003;" : "") + "</span>" + escapeHtml(s.name) + "</a>").join("") +
        "</div></details>"
      : "") + "</div>"
    : "";
  return '<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="/" aria-label="Risulta home">' + MARK + "<span>Risulta</span></a>" + switcher +
    '<nav class="nav" aria-label="Account"><details class="account-menu"><summary aria-label="Account menu"><span class="avatar" aria-hidden="true">' + avatarFor(user.display_name || user.email) + '</span><span class="account-trigger-email">' + escapeHtml(user.email) + "</span></summary>" +
    '<div class="account-panel"><span class="account-email">' + escapeHtml(user.email) + '</span><a href="/">Websites</a><a href="/account">Account settings</a>' +
    (user.role === "admin" ? '<a href="/users">Users</a><a href="/backups">Backups</a>' : "") +
    '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + user.csrf + '"><button class="link-button" type="submit">Log out</button></form>' +
    "</div></details></nav></div></header>";
}

export function pageShell(title, user, body, site, sites) {
  if (site) body = body.replace('id="main"', 'id="main" hx-history-elt');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">' +
    '<link rel="stylesheet" href="/style.css">' +
    (title === "Websites" ? '<link rel="stylesheet" href="/home.css">' : "") +
    '<link rel="icon" type="image/svg+xml" href="/favicon-light.svg" media="(prefers-color-scheme: light)">' +
    '<link rel="icon" type="image/svg+xml" href="/favicon-dark.svg" media="(prefers-color-scheme: dark)">' +
    '<link rel="manifest" href="/site.webmanifest">' +
    "<title>" + escapeHtml(title) + " - Risulta</title>" +
    '<script src="/htmx.min.js"></script><script src="/dashboard.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a>' +
    (user ? topbar(user, site || null, sites || []) : "") + body +
    (user ? '<footer class="footer"><div class="shell"><span><strong>Risulta</strong> is a standalone, experimental analytics platform grown with <a class="footer-link" href="https://sproutboat.com" target="_blank" rel="noopener">Sproutboat</a></span></div></footer>' : "") +
    "</body></html>";
}

export function loginPage(error) {
  return pageShell(
    "Sign in",
    null,
    '<main class="auth" id="main"><div class="auth-box"><div class="auth-brand">' + MARK + "<span>Risulta</span></div>" +
      '<section class="card" aria-labelledby="login-title"><h1 id="login-title">Sign in to Risulta</h1>' +
      '<p class="intro">Use one account to view all of your websites.</p>' +
      (error ? '<p class="error" id="login-error">' + escapeHtml(error) + "</p>" : "") +
      '<form class="form" method="post" action="/login">' +
      '<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>' +
      '<button class="button" type="submit">Sign in</button></form></section></div></main>',
  );
}

export function homePage(user, sites) {
  const cards = sites.length
    ? homeCards(sites)
    : '<div class="empty-card"><h2>No websites yet</h2><p>Add your first website to start collecting private analytics.</p></div>';
  return pageShell(
    "Websites",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Workspace</p><h1>Your websites</h1></div>' +
      (user.role === "admin"
        ? '<div class="actions"><a class="button" href="/sites/new">Add website</a></div>'
        : "") + "</div>" +
      '<p class="home-period hint">Last 7 days · Daily visitors</p><section aria-label="Websites">' + cards + "</section></main>",
    null,
    sites,
  );
}

export function newSitePage(user, error) {
  return pageShell(
    "Add website",
    user,
    '<main class="shell form-page" id="main"><div class="titlebar"><div><p class="eyebrow">Website administration</p><h1>Add a website</h1></div></div>' +
      '<section class="card"><form class="form" method="post" action="/api/sites"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      (error ? '<p class="error">' + escapeHtml(error) + "</p>" : "") +
      '<div class="field"><label for="name">Name</label><input id="name" name="name" required maxlength="100"><p class="hint">A friendly name, such as Marketing site.</p></div>' +
      '<div class="field"><label for="domain">Domain</label><input id="domain" name="domain" required maxlength="253" inputmode="url" placeholder="example.com">' +
      "<p class=\"hint\">Hostname only. Risulta rejects events claiming another domain.</p></div>" +
      '<div class="actions"><button class="button" type="submit">Add website</button><a class="button secondary" href="/">Cancel</a></div>' +
      "</form></section></main>",
  );
}

export function liveFragment(site, analytics, range, days, metric, comparison) {
  const metrics = analytics.summary;
  const viewsPerVisit = Number(metrics.visits) ? Number(metrics.pageviews) / Number(metrics.visits) : 0;
  const metricLabel = metric === "pageviews" ? "Pageviews" : metric === "visits" ? "Visits" : "Visitors";
  const hasData = Number(metrics.pageviews) > 0;
  const series = days === 1 && !range.from ? hourSeries(analytics.byHour) : dateSeries(days, analytics.byDay, range.until);
  const pageQuery = liveQuery(range, days, null);
  const summary = [["visitors", "Visitors", "People, counted daily"], ["visits", "Visits", "Browsing sessions"], ["pageviews", "Pageviews", "Pages loaded"]].map((item) => {
    const selected = metric === item[0];
    const previous = comparison ? Number(comparison[item[0]]) : 0;
    const change = previous ? (Number(metrics[item[0]]) - previous) / previous * 100 : 0;
    const percent = Math.round(change);
    const deltaText = previous ? (percent > 0 ? "+" : "") + percent + "%" : Number(metrics[item[0]]) ? "New" : "0%";
    const deltaLabel = previous ? deltaText + " vs previous period" : Number(metrics[item[0]]) ? "New traffic, none in the previous period" : "No traffic in either period";
    const delta = comparison ? '<span class="metric-comparison" title="' + escapeHtml(deltaLabel) + '" aria-label="' + escapeHtml(deltaLabel) + '">' + deltaText + '</span>' : "";
    return '<a class="metric overview-metric" href="/sites/' + siteSlug(site) + "?" + liveQuery(range, days, comparison) + "&metric=" + item[0] + '"' +
      (selected ? ' aria-current="true"' : "") + '><span class="metric-label">' + item[1] + '</span><strong data-metric="' + item[0] + '">' +
      fmtInt(metrics[item[0]]) + '</strong><span class="metric-description">' + item[2] + '</span>' + delta + '</a>';
  }).join("");
  const reportLink = function (dimension) {
    return '<a class="report-link" href="/sites/' + siteSlug(site) + "/reports?" + pageQuery + "&cohort=1&dimension=" + dimension + '">View report &rarr;</a>';
  };
  const conversions = analytics.hasConversions
    ? '<div id="overview-goals" class="overview-goals" hx-preserve="true" hx-get="/sites/' + siteSlug(site) + '/partials/goals?' +
      liveQuery(range, days, false) + '" hx-trigger="every 60s" hx-sync="this:drop" hx-target="this" hx-swap="innerHTML">' +
      overviewGoalsFragment(site, analytics.goals, range, days) + '</div>' : "";
  const dimensions = [["source", "Sources", analytics.referrers], ["campaign", "Campaigns", analytics.campaigns], ["medium", "Mediums", analytics.mediums]];
  const rowLink = function (dimension) {
    return function (label) {
      const filters = { ...range.filters, [dimension]: label };
      return '/sites/' + siteSlug(site) + '?' + liveQuery({ ...range, filters }, days, comparison) + '&metric=' + metric;
    };
  };
  const chips = Object.keys(range.filters || {}).map((key) => {
    const filters = { ...range.filters }; delete filters[key];
    return '<a class="filter-chip" href="/sites/' + siteSlug(site) + '?' + liveQuery({ ...range, filters }, days, comparison) + '&metric=' + metric +
      '" aria-label="' + escapeHtml('Remove ' + key + ' filter: ' + range.filters[key]) + '">' + escapeHtml(key + ': ' + range.filters[key]) + ' &times;</a>';
  }).join('');
  const filterBar = chips ? '<nav class="overview-filters" aria-label="Active visitor filters">' + chips +
    '<a class="report-link" href="/sites/' + siteSlug(site) + '?' + liveQuery({ ...range, filters: {} }, days, comparison) + '&metric=' + metric + '">Clear all</a></nav>' +
    '<p class="hint">Showing all activity from daily visitors with a pageview matching these filters.</p>' : '';
  return filterBar + '<section class="panel overview-panel" aria-label="Traffic overview"><nav class="metrics overview-metrics" aria-label="Select a chart metric">' + summary + '</nav>' +
    (hasData ? '<div class="chart-wrap"><div class="chart-heading"><h2>' + metricLabel + ' over time</h2><span class="hint"><strong data-metric="views-per-visit">' +
      oneDecimal(viewsPerVisit) + '</strong> pages per visit</span></div>' + chart(series, metric, metricLabel) + chart(series, metric, metricLabel, true) + '</div>' :
      '<div class="empty"><h2>' + (Object.keys(range.filters || {}).length ? 'No matching visitors' : 'Waiting for the first visitor') + '</h2><p>' + (Object.keys(range.filters || {}).length ? 'Try another date range or remove a filter.' : 'Install the tracker below. New visits will appear here live.') + '</p></div>') + '</section>' +
    '<div class="overview-footer"><details class="metric-help" data-disclosure="metrics"><summary>What do these numbers mean?</summary><p>Visitors are counted once per day. Someone returning on another day counts again. ' +
    'A visit is a browsing session, ending after more than 30 minutes of inactivity or at UTC midnight. Pageviews count each page loaded. Dates use UTC.</p></details>' +
    '</div>' +
    '<p class="hint metrics-note"><span class="status" id="poll-status" data-state="live"></span></p>' +
    '<div id="dashboard-reports" class="reports overview-reports">' +
    dimensions.map((item) => reportCard(item[1], item[2].slice(0, 5), "No matching traffic in this period.", reportLink(item[0]), rowLink(item[0]))).join('') +
    reportCard("Top pages", analytics.paths.slice(0, 5), "Pages will appear after the first view.", reportLink("path"), rowLink("path")) + '</div>' + conversions;

}

export function overviewGoalsFragment(site, goals, range, days) {
  return goalCard(goals, '<a class="report-link" href="/sites/' + siteSlug(site) + '/goals?' + liveQuery(range, days, false) + '">All goals &rarr;</a>');
}

export function conversionsPage(user, site, sites, goals, funnels, truncated, range) {
  return pageShell(site.name + " conversions", user,
    '<main class="shell website-dashboard" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) +
    '</p><h1>Conversions</h1><p class="dashboard-period">' + escapeHtml(periodLabel(range)) + '</p></div><a class="button secondary" href="/sites/' +
    siteSlug(site) + '?' + liveQuery(range, range.days || 7, false) + '">Back to overview</a></div><div class="conversions-workspace"><div>' +
    goalCard(goals) + '</div><div class="funnel-stack">' + funnelCard(funnels, truncated) + '</div></div></main>', site, sites);
}

function filterQuery(range) {
  let query = '';
  for (const key of Object.keys(range.filters || {})) query += '&' + key + '=' + encodeURIComponent(range.filters[key]);
  return query + '&acquisition=' + (range.acquisition || 'source');
}

function liveQuery(range, days) {
  const base = range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days;
  let query = base;
  const filters = range.filters || {};
  for (const key of Object.keys(filters)) query += "&" + key + "=" + encodeURIComponent(filters[key]);
  if (range.acquisition) query += "&acquisition=" + range.acquisition;
  return query;
}

export function reportCard(title, rows, emptyLabel, detailLinks, rowLink, tabs) {
  let max = 1;
  for (let i = 0; i < rows.length; i++) max = Math.max(max, Number(rows[i].visitors));
  const items = rows.length
    ? "<ol>" + rows.map((row) => {
      const width = Math.max(2, (Number(row.visitors) / max) * 100).toFixed(1);
      const label = '<span class="truncate" title="' + escapeHtml(row.label) + '">' + escapeHtml(row.label) + '</span>';
      return '<li><div class="row-label">' + (rowLink ? '<a class="report-row-link" href="' + escapeHtml(rowLink(row.label)) + '">' + label + '</a>' : label) + '<span class="value">' + fmtInt(row.visitors) + '</span></div><div class="meter" aria-hidden="true"><span style="width:' + width + '%"></span></div></li>';
    }).join("") + "</ol>"
    : '<p class="empty-small">' + escapeHtml(emptyLabel) + "</p>";
  const id = title.toLowerCase().replace(/ /g, "-");
  return '<section class="report" aria-labelledby="' + id + '"><div class="report-head"><h2 id="' + id + '">' + escapeHtml(title) + "</h2>" + detailLinks + '</div>' + (tabs || '') + '<p class="report-column-label">Visitors</p>' + items + "</section>";
}

export function goalCard(goals, detailLink) {
  if (!goals.length) return "";
  const items = goals.map((goal) => {
    let hint = fmtInt(goal.unique_conversions) + " unique, " + oneDecimal(Number(goal.conversion_rate) * 100) + "% conversion rate";
    if (Number(goal.value)) hint += ", " + fmtInt(goal.value) + " value";
    return '<li><div class="row-label"><span class="truncate">' + escapeHtml(goal.name) + '</span><span class="value">' + fmtInt(goal.conversions) +
      '</span></div>' + (goal.event_name ? '<p class="hint">' + escapeHtml(goal.event_name + (goal.path ? ' at ' + goal.path : '')) + '</p>' : '') + '<p class="hint">' + escapeHtml(hint) + "</p></li>";
  }).join("");
  return '<section class="report" aria-labelledby="goals-title"><div class="report-head"><h2 id="goals-title">Goals</h2>' + (detailLink || '<span>Conversions</span>') + '</div>' + (detailLink ? '<p class="report-column-label">Conversions</p>' : '') + '<ol>' + items + "</ol></section>";
}

export function funnelCard(funnels, truncated) {
  if (!funnels.length) return "";
  const items = funnels.map((funnel) =>
    '<section class="report" aria-labelledby="funnel-' + funnel.id + '"><div class="report-head"><h2 id="funnel-' + funnel.id + '">' + escapeHtml(funnel.name) + "</h2><span>Funnel</span></div><ol>" +
    funnel.steps.map((step) =>
      '<li><div class="row-label"><span class="truncate">' + escapeHtml(step.name) + '</span><span class="value">' + fmtInt(step.conversions) + "</span></div>" +
      '<p class="hint">' + (step.drop_off ? fmtInt(step.drop_off) + " dropped off" : "Starting step") + "</p></li>").join("") +
    "</ol></section>").join("");
  return items + (truncated ? '<p class="hint metrics-note">Funnel counts scan up to 50,000 events, ordered by visitor and time. Larger ranges may have incomplete funnels.</p>' : "");
}

export function siteNavigation(site, range, active) {
  const query = liveQuery(range, range.days || 7);
  const items = [["overview", "", "Overview"], ["reports", "/reports", "Reports"], ["journeys", "/reports/journeys", "Journeys"], ["goals", "/goals", "Goals"], ["funnels", "/funnels", "Funnels"], ["settings", "/settings", "Settings"]];
  return '<nav class="dashboard-navigation site-tabs" aria-label="Website analytics" hx-boost:inherited="swap:&quot;outerSync show:none&quot; select:#main target:#main">' + items.map((item) =>
    '<a href="/sites/' + siteSlug(site) + item[1] + (item[0] === "settings" ? "" : '?' + query + (item[0] === "reports" ? '&cohort=1' : '')) + '"' + (active === item[0] ? ' aria-current="page"' : '') + '>' + item[2] + '</a>').join('') + '</nav>';
}

export function siteSettingsPage(session, site, sites, error, saved, sharing, origin) {
  const form = session.role === "admin"
    ? '<section class="card"><h2>Tracked hostname</h2><p class="hint">Changing this keeps all existing analytics. Events from the previous hostname stop being accepted immediately. Keep the same tracker code on the new hostname.</p>' +
      (saved ? '<p class="success" role="status">Hostname updated.</p>' : "") +
      (error ? '<p class="error" role="alert">' + escapeHtml(error) + "</p>" : "") +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/domain"><input type="hidden" name="csrf" value="' + escapeHtml(session.csrf) + '">' +
      '<div class="field"><label for="domain">Hostname</label><input id="domain" name="domain" type="text" inputmode="url" autocomplete="url" maxlength="253" required value="' + escapeHtml(site.domain) + '"></div>' +
      '<div class="actions"><button class="button" type="submit">Save hostname</button></div></form></section>'
    : '<section class="card"><h2>Tracked hostname</h2><p>' + escapeHtml(site.domain) + '</p><p class="hint">Ask an administrator to change this hostname.</p></section>';
  const widget = session.role === "admin" ? '<section class="card"><h2>Public widget</h2><p class="hint">Share visitor totals, pageviews and a seven-day chart. Raw events and visitor identities stay private.</p><form class="form" method="post" action="/api/sites/'+site.id+'/public-widget"><input type="hidden" name="csrf" value="'+escapeHtml(session.csrf)+'"><label><input type="checkbox" name="enabled" value="1"'+(sharing && sharing.enabled ? ' checked' : '')+'> Enable public sharing</label><button class="button secondary" type="submit">Save sharing</button></form><p class="hint">Choose small, medium or wide with data-size. Set data-theme to light or dark.</p><pre class="setup">'+escapeHtml('<script async src="'+origin+'/widget.js" data-site="'+site.public_key+'" data-size="medium" data-theme="light"></script>')+'</pre></section>' : "";
  return pageShell("Website settings", session,
    '<main class="shell website-dashboard settings-page" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + '</p><h1>Settings</h1><p class="dashboard-period">Website configuration</p></div><div class="settings-header-space" aria-hidden="true"></div></div>' +
    siteNavigation(site, { days: 7, filters: {} }, "settings") + form + widget + '</main>', site, sites);
}

function periodLabel(range) {
  return range.from ? range.from + " to " + range.to : range.days === 1 ? "Today" : "Last " + (range.days || 7) + " days";
}

function dateTabs(site, range, path, extra) {
  return '<nav class="periods" aria-label="Date range">' + [1, 7, 30].map((period) =>
    '<a href="/sites/' + siteSlug(site) + path + '?period=' + period + filterQuery(range) + (extra || '') + '"' +
    (!range.from && period === (range.days || 7) ? ' aria-current="page"' : '') + '>' +
    (period === 1 ? 'Today' : period + 'd') + '</a>').join('') + '</nav>';
}

function trackerButton(site, origin) {
  const snippet = '<script defer src="' + origin + '/js/' + site.public_key + '.js"></script>';
  return '<button class="button secondary tracker-copy" type="button" data-copy-code data-copy-value="' + escapeHtml(snippet) + '" title="Copy the script to paste into your site’s head"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="4" rx="1.5"/><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/></svg>Copy tracker code</button>';
}

export function sitePage(user, site, sites, analytics, range, days, metric, origin, comparison) {
  const title = periodLabel(range);
  const hasData = Number(analytics.summary.pageviews) > 0;
  const statsBase = "/sites/" + siteSlug(site) + "/partials/live?" + (range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days) + "&metric=" + metric + filterQuery(range);
  const periodTabs = [1, 7, 30].map((period) =>
    '<a href="/sites/' + siteSlug(site) + "?period=" + period + "&metric=" + metric + filterQuery(range) + '"' + (!range.from && period === days ? ' aria-current="page"' : "") + ">" +
    (period === 1 ? "Today" : period + "d") + "</a>").join("");
  const snippet = '<script defer src="' + origin + "/js/" + site.public_key + '.js"></script>';
  const install = '<section class="card install" aria-labelledby="install-title"><h2 id="install-title">Install the tracker</h2><p>Paste this into the <code>&lt;head&gt;</code> of ' +
    escapeHtml(site.domain) + '.</p><div class="snippet" role="region" tabindex="0" aria-label="Tracker installation code"><code>' + escapeHtml(snippet) +
    '</code></div><button class="button secondary" type="button" data-copy-code>Copy code</button></section>';
  return pageShell(
    site.name + " analytics",
    user,
    '<main class="shell website-dashboard" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><div class=\"overview-title\"><h1>Overview</h1>" + trackerButton(site, origin) + "</div><p class=\"dashboard-period\">" + escapeHtml(title) + "</p></div>" +
      '<nav class="periods" aria-label="Date range">' + periodTabs + '</nav></div>' +
      siteNavigation(site, range, 'overview') +
      '<div class="dashboard-toolbar"><div id="live-current" aria-live="polite"><span class="current"><span class="site-dot" aria-hidden="true"></span><strong id="live-current-value" data-current>' +
      fmtInt(analytics.current) + '</strong> online now</span></div>' +
      '<details class="range-picker"><summary class="button secondary">Custom range</summary>' +
      '<form class="range-form" method="get" action="/sites/' + siteSlug(site) + '"><input type="hidden" name="metric" value="' + escapeHtml(metric) + '">' +
      Object.keys(range.filters || {}).map((key) => '<input type="hidden" name="' + key + '" value="' + escapeHtml(range.filters[key]) + '">').join('') +
      '<input type="hidden" name="acquisition" value="' + (range.acquisition || 'source') + '">' +
      '<label class="compact-field" for="range-from"><span>From</span><input id="range-from" name="from" type="date" required value="' + escapeHtml(range.from) + '"></label>' +
      '<label class="compact-field" for="range-to"><span>To</span><input id="range-to" name="to" type="date" required value="' + escapeHtml(range.to) + '"></label>' +
      '<button class="button secondary" type="submit">Apply</button></form></details></div>' +
      '<div id="live-stats" data-stats-url="' + statsBase + '" hx-get="' + statsBase + '" hx-trigger="every 30s" hx-sync="this:drop" hx-target="#live-stats" hx-swap="innerHTML">' +
      liveFragment(site, analytics, range, days, metric, comparison) +
      "</div>" + (hasData || Object.keys(range.filters || {}).length ? "" : install) + "</main>",
    site,
    sites,
  );
}

export function usersPage(admin, users, sites, backup) {
  const backupMessages = {
    success: "Database backup created in the server's backups directory. Copy it off the server for safekeeping.",
    failed: "Database backup failed. Try again or check the server logs.",
    csrf: "Backup was not created. Reload this page and try again.",
  };
  const backupMessage = backupMessages[backup] || "";
  const records = users.map((u) =>
    '<li class="user-record"><div class="user-identity"><strong>' + escapeHtml(u.display_name || u.email) + "</strong><span>" + escapeHtml(u.email) + "</span></div>" +
    '<div class="user-access"><span class="badge">' + escapeHtml(u.role) + "</span><span>" + escapeHtml(u.role === "admin" ? "All websites" : u.sites || "No websites assigned") + "</span>" +
    (u.id !== admin.user_id
      ? '<form class="inline" method="post" action="/api/users/' + u.id + '/delete"><input type="hidden" name="csrf" value="' + admin.csrf + '"><button class="link-button" type="submit">Delete</button></form>'
      : "<span>(you)</span>") + "</div></li>").join("");
  const checks = sites.length
    ? sites.map((s) => '<label class="check"><input type="checkbox" name="site" value="' + s.id + '"><span>' + escapeHtml(s.name) + ' <span class="hint">' + escapeHtml(s.domain) + "</span></span></label>").join("")
    : '<p class="hint">Add a website before assigning a viewer.</p>';
  return pageShell(
    "Users",
    admin,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Administration</p><h1>Users</h1></div></div>' +
      '<div class="users-workspace"><section class="card"><h2>Create user</h2><form class="form" method="post" action="/api/users">' +
      '<input type="hidden" name="csrf" value="' + admin.csrf + '">' +
      '<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off" required></div>' +
      '<div class="field"><label for="password">Temporary password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required><p class="hint">Use at least 12 characters.</p></div>' +
      '<div class="field"><label for="role">Access level</label><select id="role" name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></div>' +
      '<fieldset class="checks"><legend class="legend">Viewer websites</legend>' + checks + "</fieldset>" +
      '<button class="button" type="submit">Create user</button></form></section>' +
      '<section class="card users-panel" aria-labelledby="existing-users-title"><div class="users-head"><div><h2 id="existing-users-title">Existing users</h2><p>' +
      users.length + " account" + (users.length === 1 ? "" : "s") + "</p></div></div>" +
      '<ol class="user-list">' + records + "</ol></section></div>" +
      '<section class="card settings-section backup-shortcut" aria-labelledby="backup-title"><div class="backup-section-heading"><h2 id="backup-title">Database backup</h2><a class="report-link" href="/backups">Schedule and history &rarr;</a></div>' +
      '<p class="hint" id="backup-help">Create a snapshot in the server&#39;s backups directory. This does not download a file.</p>' +
      '<form class="form" method="post" action="/api/backup" data-backup-form>' +
      '<input type="hidden" name="csrf" value="' + escapeHtml(admin.csrf) + '">' +
      '<button class="button" type="submit" aria-describedby="backup-help">Create backup</button></form>' +
      '<p class="backup-feedback" data-backup-feedback>' + escapeHtml(backupMessage) + '</p>' +
      '<div data-backup-toast role="status" aria-live="polite" aria-atomic="true"></div></section></main>',
    null,
    [],
  );
}

function backupSize(bytes) {
  if (bytes >= 1048576) return oneDecimal(bytes / 1048576) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function backupsPage(admin, settings, history, message, error) {
  const pad = function (n) { return n < 10 ? "0" + n : String(n); };
  const connected = Number(settings.runner_seen) > Math.floor(Date.now() / 1000) - 180;
  const scheduled = settings.frequency !== "off";
  const status = scheduled ? (connected ? "Schedule active" : "Starting scheduler") : "Manual backups only";
  const rows = history.map((item) => '<tr><td>' + journeyTime(item.created_at) + ' UTC</td><td>' +
    (item.kind === "scheduled" ? "Scheduled" : "Manual") + '</td><td><span class="badge">' + escapeHtml(item.status) +
    '</span></td><td>' + (item.bytes ? backupSize(item.bytes) : "") + '</td></tr>').join("");
  return pageShell("Backups", admin,
    '<main class="shell backups-page" id="main"><div class="titlebar"><div><p class="eyebrow">Administration</p><h1>Backups</h1>' +
    '<p class="journeys-intro">Keep a recoverable copy of your analytics and accounts.</p></div><span class="badge">' + status + '</span></div>' +
    (message ? '<p class="' + (error ? "error" : "success") + '" role="status">' + escapeHtml(message) + '</p>' : "") +
    '<div class="backup-workspace"><section class="card backup-section"><h2>Create a backup</h2><p>Save a complete database snapshot on this server, without stopping analytics.</p>' +
    '<dl class="backup-scope"><div><dt>Includes</dt><dd>All websites, events and accounts</dd></div><div><dt>Destination</dt><dd>This server&#39;s backups folder</dd></div></dl>' +
    '<form class="form" method="post" action="/api/backup" data-backup-form><input type="hidden" name="csrf" value="' + escapeHtml(admin.csrf) +
    '"><button class="button" type="submit">Create backup now</button></form><p class="backup-feedback" data-backup-feedback></p>' +
    '<div data-backup-toast role="status" aria-live="polite" aria-atomic="true"></div></section>' +
    '<section class="card backup-section"><h2>Automatic backups</h2><p>Choose when to back up and how many scheduled copies to keep.</p>' +
    '<form class="form" method="post" action="/api/backup/settings"><input type="hidden" name="csrf" value="' + escapeHtml(admin.csrf) + '">' +
    '<div class="field"><label for="backup-frequency">Schedule</label><select id="backup-frequency" name="frequency">' +
    [["off", "Manual only"], ["daily", "Every day"], ["weekly", "Every Monday"]].map((option) => '<option value="' + option[0] + '"' +
      (settings.frequency === option[0] ? " selected" : "") + '>' + option[1] + '</option>').join("") + '</select></div>' +
    '<div class="backup-field-pair"><div class="field"><label for="backup-time">Time (UTC)</label><input id="backup-time" name="time" type="time" required value="' +
    pad(settings.hour) + ':' + pad(settings.minute) + '"></div><div class="field"><label for="backup-retention">Copies to keep</label><input id="backup-retention" name="retention" type="number" min="1" max="90" required value="' +
    settings.retention + '"></div></div><p class="hint">Retention applies to scheduled backups. Manual snapshots are kept.</p><button class="button secondary" type="submit">Save schedule</button></form>' +
    (!connected ? '<p class="backup-runner-note">Risulta checks your saved schedule every minute. If this status persists, check the server logs.</p>' : "") + '</section></div>' +
    '<section class="card backup-history"><div class="report-titlebar"><div><h2>Recent backups</h2><p class="hint">The 20 most recent attempts. Files remain on the server.</p></div></div>' +
    (rows ? '<div class="table-scroll" tabindex="0" role="region" aria-label="Backup history"><table class="data-table"><thead><tr><th scope="col">Created (UTC)</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Size</th></tr></thead><tbody>' + rows +
      '</tbody></table></div>' : '<div class="backup-history-empty"><p>No backups recorded yet.</p><p class="hint">Create a backup to see it here. Older files are still in the server&#39;s backups folder.</p></div>') + '</section>' +
    '<details class="backup-guide"><summary>Set up automatic backups and recovery</summary><div><h2>Save a schedule</h2><p>Risulta runs scheduled backups from its own executable. Save a daily or weekly schedule above.</p>' +
    '<p><a class="report-link" href="/backup-setup.txt">Open backup and recovery instructions</a></p>' +
    '<h2>Keep a copy elsewhere</h2><p>Copy snapshots off this server for protection against disk failure. Database snapshots include account and session data, so keep them private.</p>' +
    '<h2>Restore safely</h2><p>Stop Risulta, preserve the current database and its WAL sidecars, then restore a verified snapshot at d1/DB.sqlite before restarting. Test restoration on a separate instance first.</p></div></details></main>', null, []);
}

export function accountPage(user, options) {
  const settings = options || {};
  const profileMessages = {
    "name-required": '<p class="error" role="alert">Enter your display name.</p>',
    "email-invalid": '<p class="error" role="alert">Enter a valid email address.</p>',
    "email-registered": '<p class="error" role="alert">That email address is already in use.</p>',
  };
  const profileMessage = settings.profile === "1"
    ? '<p hidden data-toast>Profile updated.</p>'
    : profileMessages[settings.profile] || "";
  const displayName = user.display_name || user.email.split("@")[0];
  return pageShell(
    "Account settings",
    user,
    '<main class="shell form-page" id="main"><div class="titlebar"><div><p class="eyebrow">Account</p><h1>Account settings</h1></div></div>' +
      '<section class="card settings-section" aria-labelledby="profile-title"><h2 id="profile-title">Profile</h2>' + profileMessage +
      '<div class="profile-avatar"><img class="avatar" data-avatar-preview src="/avatar.svg?name=' + encodeURIComponent(displayName) + '" alt="Avatar preview">' +
      '<p class="hint">Your avatar is generated from your display name.</p></div>' +
      '<form class="form" method="post" action="/api/account/profile"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      '<div class="field"><label for="display-name">Display name</label><input id="display-name" name="displayName" autocomplete="name" maxlength="80" required value="' + escapeHtml(displayName) + '"></div>' +
      '<div class="field"><label for="profile-email">Email</label><input id="profile-email" name="email" type="email" autocomplete="email" required value="' + escapeHtml(user.email) + '"></div>' +
      '<div class="actions"><button class="button" type="submit">Save profile</button></div></form></section>' +
      '<section class="card settings-section" aria-labelledby="password-title"><h2 id="password-title">Change password</h2>' +
      '<p class="hint">Changing your password signs out your other active sessions.</p>' +
      (settings.changed ? '<p class="success" role="status">Password changed. Other sessions were signed out.</p>' : "") +
      '<form class="form" method="post" action="/api/account/password"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      '<div class="field"><label for="current-password">Current password</label><input id="current-password" name="current" type="password" autocomplete="current-password" required></div>' +
      '<div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" autocomplete="new-password" minlength="12" required><p class="hint">Use at least 12 characters.</p></div>' +
      '<div class="actions"><button class="button" type="submit">Change password</button></div></form></section>' +
      '<section class="card settings-section" aria-labelledby="delete-title"><h2 id="delete-title">Delete account</h2>' +
      '<p class="hint">Deleting your account signs you out everywhere and cannot be undone. Type DELETE to confirm.</p>' +
      '<form class="form" method="post" action="/api/account/delete"><input type="hidden" name="csrf" value="' + user.csrf + '">' +
      '<div class="field"><label for="delete-confirmation">Confirmation</label><input id="delete-confirmation" name="confirmation" required maxlength="6" placeholder="DELETE"></div>' +
      '<div class="actions"><button class="button" type="submit">Delete account</button></div></form></section></main>',
    null,
    [],
  );
}

export function reportsPage(user, site, sites, report, range, days) {
  const dimensions = [["path", "Pages"], ["source", "Sources"], ["medium", "Mediums"], ["campaign", "Campaigns"], ["event", "Events"]];
  const base = { cohort: report.cohort ? "1" : "", dimension: report.dimension, period: String(days), limit: String(report.limit), offset: String(report.offset), sort: report.sort };
  if (range.from) {
    base.from = range.from;
    base.to = range.to;
    base.period = "";
  }
  const filterNames = ["path", "source", "medium", "campaign", "event"];
  for (let i = 0; i < filterNames.length; i++) {
    if (report.filters[filterNames[i]]) base[filterNames[i]] = report.filters[filterNames[i]];
  }
  const tabLink = function (dimension) {
    const params = { cohort: base.cohort, dimension: dimension, period: base.period, limit: base.limit, offset: "0", sort: base.sort };
    if (base.from) {
      params.from = base.from;
      params.to = base.to;
    }
    for (let i = 0; i < filterNames.length; i++) {
      if (base[filterNames[i]]) params[filterNames[i]] = base[filterNames[i]];
    }
    return "/sites/" + siteSlug(site) + "/reports?" + reportQuery(params);
  };
  const tabs = dimensions.map(function (entry) {
    return '<a href="' + tabLink(entry[0]) + '"' + (report.dimension === entry[0] ? ' aria-current="page"' : "") + ">" + escapeHtml(entry[1]) + "</a>";
  }).join("");
  const filterFields = [["path", "Page path", "filter-path"], ["source", "Source", "filter-source"], ["campaign", "Campaign", "filter-campaign"], ["event", "Event", "filter-event"]].map(function (field) {
    return '<label class="filter-field" for="' + field[2] + '"><span>' + field[1] + '</span><input id="' + field[2] + '" name="' + field[0] + '" value="' + escapeHtml(report.filters[field[0]] || "") + '"></label>';
  }).join("");
  const clearParams = { dimension: report.dimension, period: base.period, limit: base.limit, offset: "0", sort: base.sort };
  if (base.from) {
    clearParams.from = base.from;
    clearParams.to = base.to;
  }
  const filterForm = '<form class="filter-grid" method="get" action="/sites/' + siteSlug(site) + '/reports">' +
    (report.cohort ? '<input type="hidden" name="cohort" value="1">' : "") +
    '<input type="hidden" name="dimension" value="' + escapeHtml(report.dimension) + '">' +
    '<input type="hidden" name="period" value="' + escapeHtml(base.period) + '">' +
    (base.from ? '<input type="hidden" name="from" value="' + escapeHtml(base.from) + '"><input type="hidden" name="to" value="' + escapeHtml(base.to) + '">' : "") +
    filterFields +
    '<button class="button secondary" type="submit">Filter</button>' +
    '<a class="button secondary" href="/sites/' + siteSlug(site) + "/reports?" + reportQuery(clearParams) + '">Clear</a></form>';
  const rows = report.rows.map(function (row) {
    return '<tr><td><details class="report-label"><summary title="' + escapeHtml(row.label) + '"><span>' + escapeHtml(row.label) + '</span></summary><p>' + escapeHtml(row.label) + '</p></details></td><td>'  + fmtInt(row.pageviews) + "</td><td>" + fmtInt(row.visitors) + "</td><td>" + fmtInt(row.value) + "</td></tr>";
  }).join("");
  const previous = Math.max(0, report.offset - report.limit);
  const next = report.offset + report.limit;
  const pageParams = function (offset) {
    const params = { cohort: base.cohort, dimension: base.dimension, period: base.period, limit: base.limit, offset: String(offset), sort: base.sort };
    if (base.from) {
      params.from = base.from;
      params.to = base.to;
    }
    for (let i = 0; i < filterNames.length; i++) {
      if (base[filterNames[i]]) params[filterNames[i]] = base[filterNames[i]];
    }
    return "/sites/" + siteSlug(site) + "/reports?" + reportQuery(params);
  };
  const pageLinks = '<nav class="actions" aria-label="Report pages">' +
    (report.offset ? '<a class="button secondary" href="' + pageParams(previous) + '">Previous</a>' : "") +
    (next < report.total ? '<a class="button secondary" href="' + pageParams(next) + '">Next</a>' : "") + "</nav>";
  const csvParams = { cohort: base.cohort, dimension: base.dimension, period: base.period, limit: base.limit, offset: base.offset, sort: base.sort };
  if (base.from) {
    csvParams.from = base.from;
    csvParams.to = base.to;
  }
  for (let i = 0; i < filterNames.length; i++) {
    if (base[filterNames[i]]) csvParams[filterNames[i]] = base[filterNames[i]];
  }
  const title = report.dimension === "path" ? "Pages" : report.dimension === "source" ? "Sources" : report.dimension === "medium" ? "Mediums" : report.dimension === "campaign" ? "Campaigns" : "Events";
  return pageShell(
    site.name + " report",
    user,
    '<main class="shell website-dashboard" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>Reports</h1><p class=\"dashboard-period\">" + escapeHtml(periodLabel(range)) + '</p></div>' + dateTabs(site, range, '/reports', '&cohort=' + (report.cohort ? '1' : '0') + '&dimension=' + report.dimension) + '</div>' +
      siteNavigation(site, range, 'reports') + '<nav class="periods report-tabs" aria-label="Report dimension">' + tabs + '</nav>' + filterForm +
      (report.cohort ? '<p class="hint">Showing activity from daily visitors matching the selected source, page or campaign filters.</p>' : '') +
      '<section class="card report-table-card" aria-labelledby="report-title"><div class="report-titlebar"><div><h2 id="report-title">' + escapeHtml(title) + '</h2><p class="hint">' +
      fmtInt(report.total) + " row" + (report.total === 1 ? "" : "s") + "</p></div></div>" +
      (report.rows.length
        ? '<div class="table-scroll" tabindex="0" role="region" aria-label="Report results"><table class="data-table report-data-table"><thead><tr><th scope="col">Label</th><th scope="col">Pageviews</th><th scope="col">Visitors</th><th scope="col">Value</th></tr></thead><tbody>' +
          rows + "</tbody></table></div>"
        : '<p class="empty-small">No matching rows. Adjust the range or filters.</p>') +
      '<div class="report-footer"><p><a class="footer-link" href="/api/sites/' + site.id + "/report?" + reportQuery(csvParams) + '&format=csv">Download CSV</a></p>' + pageLinks + "</div></section></main>",
    site,
    sites,
  );
}

function clearJourneyRange(range, days) {
  return { ...(range.from ? { from: range.from, to: range.to } : { period: String(days) }), ...range.filters, cohort: "1" };
}

function journeyTime(ts) {
  const seconds = ((ts % 86400) + 86400) % 86400;
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const remainder = String(seconds % 60).padStart(2, "0");
  return dayStringFromMs(ts * 1000) + " " + hours + ":" + minutes + ":" + remainder;
}

function journeyDuration(seconds) {
  if (seconds < 60) return seconds + "s";
  return Math.floor(seconds / 60) + "m" + (seconds % 60 ? " " + (seconds % 60) + "s" : "");
}

export function journeysPage(user, site, sites, report, range) {
  const base = clearJourneyRange(range, range.days);
  const link = function (visitor, offset) {
    return "/sites/" + siteSlug(site) + "/reports/journeys?" + reportQuery(base) +
      "&visitor=" + encodeURIComponent(visitor) + "&limit=" + report.limit + "&offset=" + offset;
  };
  const rows = report.rows.map(function (journey) {
    const eventRows = journey.events.map(function (event) {
      return '<tr><td class="journey-clock">' + journeyTime(event.ts).slice(11) +
        '</td><td><span class="journey-event' + (event.name === "pageview" ? "" : " journey-event-custom") + '">' + escapeHtml(event.name) +
        '</span></td><td class="journey-path">' + (event.path.length > 80 ? '<details class="report-label"><summary><span>' + escapeHtml(event.path) + '</span></summary><p>' + escapeHtml(event.path) + '</p></details>' : escapeHtml(event.path)) + '</td><td class="journey-value">' +
        (event.value === null ? '<span class="journey-no-value" aria-label="No value">&#183;</span>' : escapeHtml(String(event.value))) + "</td></tr>";
    });
    const events = eventRows.slice(0, 12).join("");
    const headingId = "journey-" + journey.session;
    return '<section class="card journey-card" aria-labelledby="' + headingId + '"><header class="journey-header"><div class="journey-identity"><h2 id="' +
      headingId + '"><a href="' + link(journey.visitor, 0) + '">Visitor <span class="journey-hash">' +
      escapeHtml(journey.visitor.slice(0, 8)) + '</span></a></h2><p class="hint">' + journeyTime(journey.start) +
      ' UTC</p></div><dl class="journey-meta"><div><dt>Events</dt><dd>' + journey.events.length +
      '</dd></div><div><dt>Duration</dt><dd>' + journeyDuration(journey.end - journey.start) +
      '</dd></div></dl></header><div class="table-scroll" tabindex="0" role="region" aria-labelledby="' + headingId + '">' +
      '<table class="data-table journey-table"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Event</th><th scope="col">Path</th><th scope="col" class="journey-value">Value</th></tr></thead><tbody>' +
      events + "</tbody></table></div>" +
      (eventRows.length > 12 ? '<details class="journey-more"><summary>Show ' + (eventRows.length - 12) + ' more events</summary><div class="table-scroll" tabindex="0" role="region" aria-label="Additional journey events"><table class="data-table journey-table"><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Event</th><th scope="col">Path</th><th scope="col" class="journey-value">Value</th></tr></thead><tbody>' + eventRows.slice(12).join("") + '</tbody></table></div></details>' : "") + "</section>";
  }).join("");
  const next = report.offset + report.limit;
  const pages = '<nav class="actions journey-pagination" aria-label="Journey pages">' +
    (report.offset ? '<a class="button secondary" href="' + link(report.visitor, Math.max(0, report.offset - report.limit)) + '">Previous</a>' : "") +
    (next < report.total ? '<a class="button secondary" href="' + link(report.visitor, next) + '">Next</a>' : "") + "</nav>";
  return pageShell(site.name + " journeys", user,
    '<main class="shell website-dashboard journeys-page" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) +
    '</p><h1>Journeys</h1><p class="dashboard-period">' + escapeHtml(periodLabel(range)) + '</p></div>' +
    dateTabs(site, range, '/reports/journeys') + '</div>' +
    siteNavigation(site, range, 'journeys') + '<div class="journeys-toolbar"><p><strong>' + fmtInt(report.total) + (report.truncated ? "+" : "") +
    (report.total === 1 ? " visit" : " visits") + '</strong></p>' +
    (report.visitor ? '<a class="button secondary" href="' + link("", 0) + '">All visitors</a>' : "") + '</div>' +
    (Object.keys(range.filters || {}).length ? '<p class="hint">Daily visitors matching: ' + escapeHtml(Object.keys(range.filters).map((key) => key + ': ' + range.filters[key]).join(', ')) + '</p>' : '') +
    '<details class="journeys-note"><summary>How visits are grouped</summary><p>Visitor hashes are anonymous, site-specific and reset daily. ' +
    'A new visit starts after more than 30 minutes of inactivity or at UTC midnight. All event types are included. ' +
    'Only activity within the selected range is shown.</p></details>' +
    (report.truncated ? '<p class="journeys-warning" role="status">Showing the first ' + report.eventLimit + ' events. Some visits may be incomplete. Select a visitor or a shorter date range to see more.</p>' : "") +
    '<div class="journeys-list">' + (rows || '<section class="card empty-card"><h2>No visits to show</h2><p>Choose a different date range in reports or return to all visitors.</p><a class="button secondary" href="' + link("", 0) + '">All visitors</a></section>') +
    '</div>' + pages + "</main>",
    site, sites);
}

function reportQuery(params) {
  const names = ["cohort", "dimension", "period", "from", "to", "limit", "offset", "sort", "path", "source", "medium", "campaign", "event"];
  const parts = [];
  for (let i = 0; i < names.length; i++) {
    const value = params[names[i]];
    if (value !== undefined && value !== null && String(value) !== "") parts.push(names[i] + "=" + encodeURIComponent(String(value)));
  }
  return parts.join("&");
}

export function measurementPage(session, site, sites, goals, goalResults, funnelResults, truncated, range, kind, error) {
  const errorMessages = {
    "goal-name-required": "Enter a goal name.",
    "goal-event-invalid": "Use a valid event name.",
    "goal-path-invalid": "The path must start with /.",
    "goal-name-registered": "That goal name is already in use.",
    "funnel-name-required": "Enter a funnel name.",
    "funnel-steps-invalid": "Select at least two distinct goals of this site.",
    "funnel-save-failed": "Unable to save this funnel.",
  };
  const goalForm = session.role === "admin"
    ? '<section class="card settings-section" aria-labelledby="goals-settings-title"><h2 id="goals-settings-title">Create a goal</h2><p class="hint">Track a custom event or a pageview at one exact path.</p>' +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/goals"><input type="hidden" name="csrf" value="' + session.csrf + '"><input type="hidden" name="return_query" value="' + escapeHtml(liveQuery(range, range.days || 7)) + '">' +
      '<div class="field"><label for="goal-name">Goal name</label><input id="goal-name" name="name" required maxlength="80" placeholder="Signup"></div>' +
      '<div class="field"><label for="goal-event">Event name</label><input id="goal-event" name="event_name" required maxlength="64" placeholder="signup or pageview"></div>' +
      '<div class="field"><label for="goal-path">Exact page path (optional)</label><input id="goal-path" name="path" maxlength="2048" placeholder="/pricing"></div>' +
      '<div class="actions"><button class="button" type="submit">Add goal</button></div></form>' +
      "</section>"
    : "";
  const funnelOptions = goals.map((g) => '<option value="' + g.id + '">' + escapeHtml(g.name) + "</option>").join("");
  const funnelForm = session.role === "admin" && goals.length >= 2
    ? '<section class="card settings-section" aria-labelledby="funnels-settings-title"><h2 id="funnels-settings-title">Create a funnel</h2><p class="hint">Select goals in the order visitors should complete them.</p>' +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/funnels"><input type="hidden" name="csrf" value="' + session.csrf + '"><input type="hidden" name="return_query" value="' + escapeHtml(liveQuery(range, range.days || 7)) + '">' +
      '<div class="field"><label for="funnel-name">Funnel name</label><input id="funnel-name" name="name" required maxlength="100"></div>' +
      '<div class="field"><label for="funnel-goal-1">Step 1</label><select id="funnel-goal-1" name="goal" required><option value="">Select a goal</option>' + funnelOptions + "</select></div>" +
      '<div class="field"><label for="funnel-goal-2">Step 2</label><select id="funnel-goal-2" name="goal" required><option value="">Select a goal</option>' + funnelOptions + "</select></div>" +
      '<div class="field"><label for="funnel-goal-3">Step 3 (optional)</label><select id="funnel-goal-3" name="goal"><option value="">No third step</option>' + funnelOptions + "</select></div>" +
      '<div class="actions"><button class="button" type="submit">Add funnel</button></div></form>' +
      "</section>"
    : "";
  const errorMessage = errorMessages[error] || "";
  const title = kind === "goals" ? "Goals" : "Funnels";
  const days = range.days || 7;
  const ranges = [1, 7, 30].map((period) => '<a href="/sites/' + siteSlug(site) + '/' + kind + '?period=' + period + filterQuery(range) + '"' + (!range.from && period === days ? ' aria-current="page"' : '') + '>' + (period === 1 ? 'Today' : period + 'd') + '</a>').join('');
  const results = kind === "goals" ? goalCard(goalResults) : funnelCard(funnelResults, truncated);
  const empty = '<section class="card empty-card"><h2>No ' + title.toLowerCase() + ' yet</h2><p>' + (kind === "goals" ? 'Define an event or page to measure the actions that matter.' : 'Connect two or more goals to see where visitors drop off.') + '</p></section>';
  const form = kind === "goals" ? goalForm : funnelForm || (session.role === "admin" ? '<section class="card measurement-create"><h2>Create a funnel</h2><p class="hint">Add at least two goals before building a funnel.</p><a class="button secondary" href="/sites/' + siteSlug(site) + '/goals?' + liveQuery(range, days) + '">Create goals</a></section>' : '');
  return pageShell(site.name + " " + title.toLowerCase(), session,
    '<main class="shell website-dashboard measurement-page" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + '</p><h1>' + title + '</h1><p class="dashboard-period">' + escapeHtml(periodLabel(range)) + '</p></div><nav class="periods" aria-label="Date range">' + ranges + '</nav></div>' +
    siteNavigation(site, range, kind) + (errorMessage ? '<p class="error" role="alert">' + escapeHtml(errorMessage) + '</p>' : '') +
    (Object.keys(range.filters || {}).length ? '<p class="hint measurement-context">Daily visitors matching: ' + escapeHtml(Object.keys(range.filters).map((key) => key + ': ' + range.filters[key]).join(', ')) + '</p>' : '') +
    '<div class="measurement-workspace' + (form ? '' : ' measurement-readonly') + '"><div class="measurement-results">' + (results || empty) + '</div>' + (form ? '<aside class="measurement-create" aria-label="Create ' + (kind === 'goals' ? 'a goal' : 'a funnel') + '">' + form + '</aside>' : '') + '</div></main>', site, sites);
}
