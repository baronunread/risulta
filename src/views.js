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
// Cog6Tooth from Heroicons (MIT, Tailwind Labs) - https://heroicons.com
const GEAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>';

function topbar(user, site, sites) {
  const gear = site && user.role === "admin"
    ? '<a class="site-settings" href="/sites/' + site.id + '/settings" aria-label="Website settings" title="Website settings">' + GEAR + "</a>"
    : "";
  const switcher = site
    ? '<div class="site-context">' + (sites.length > 1
      ? '<details class="site-switcher"><summary class="site-switcher-trigger"><span>' + escapeHtml(site.name) +
        '</span><span class="select-chevron" aria-hidden="true"></span></summary><div class="site-switcher-menu">' +
        sites.map((s) => '<a href="/sites/' + s.id + '"' + (s.id === site.id ? ' aria-current="page"' : "") + "><span>" + (s.id === site.id ? "&#10003;" : "") + "</span>" + escapeHtml(s.name) + "</a>").join("") +
        "</div></details>"
      : "") + gear + "</div>"
    : "";
  return '<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="/" aria-label="Risulta home">' + MARK + "<span>Risulta</span></a>" + switcher +
    '<nav class="nav" aria-label="Account"><details class="account-menu"><summary aria-label="Account menu"><span class="avatar" aria-hidden="true">' + avatarFor(user.display_name || user.email) + '</span><span class="account-trigger-email">' + escapeHtml(user.email) + "</span></summary>" +
    '<div class="account-panel"><span class="account-email">' + escapeHtml(user.email) + '</span><a href="/">Websites</a><a href="/account">Account settings</a>' +
    (user.role === "admin" ? '<a href="/users">Users</a><a href="/backups">Backups</a>' : "") +
    '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + user.csrf + '"><button class="link-button" type="submit">Log out</button></form>' +
    "</div></details></nav></div></header>";
}

export function pageShell(title, user, body, site, sites) {
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
    const delta = comparison ? '<span class="metric-comparison">' + (previous ? (change > 0 ? "+" : "") + oneDecimal(change) + "% vs previous period" : "No previous traffic") + '</span>' : "";
    return '<a class="metric overview-metric" href="/sites/' + site.id + "?" + liveQuery(range, days, comparison) + "&metric=" + item[0] + '"' +
      (selected ? ' aria-current="true"' : "") + '><span class="metric-label">' + item[1] + '</span><strong data-metric="' + item[0] + '">' +
      fmtInt(metrics[item[0]]) + '</strong><span class="metric-description">' + item[2] + '</span>' + delta + '</a>';
  }).join("");
  const reportLink = function (dimension) {
    return '<a class="report-link" href="/sites/' + site.id + "/reports?" + pageQuery + "&cohort=1&dimension=" + dimension + '">View report &rarr;</a>';
  };
  const conversions = analytics.hasConversions
    ? '<div id="overview-goals" class="overview-goals" hx-preserve="true" hx-get="/sites/' + site.id + '/partials/goals?' +
      liveQuery(range, days, false) + '" hx-trigger="every 60s" hx-sync="this:drop" hx-target="this" hx-swap="innerHTML">' +
      overviewGoalsFragment(site, analytics.goals, range, days) + '</div>' : "";
  const acquisition = range.acquisition || "source";
  const dimensions = [["source", "Sources", analytics.referrers], ["campaign", "Campaigns", analytics.campaigns], ["medium", "Mediums", analytics.mediums]];
  const tabs = '<nav class="acquisition-tabs" aria-label="Acquisition reports">' + dimensions.map((item) =>
    '<a href="/sites/' + site.id + '?' + liveQuery({ ...range, acquisition: item[0] }, days, comparison) + '&metric=' + metric + '"' +
    (acquisition === item[0] ? ' aria-current="page"' : '') + '>' + item[1] + '</a>').join('') + '</nav>';
  const selected = dimensions[acquisition === "campaign" ? 1 : acquisition === "medium" ? 2 : 0];
  const rowLink = function (dimension) {
    return function (label) {
      const filters = { ...range.filters, [dimension]: label };
      return '/sites/' + site.id + '?' + liveQuery({ ...range, filters }, days, comparison) + '&metric=' + metric;
    };
  };
  const chips = Object.keys(range.filters || {}).map((key) => {
    const filters = { ...range.filters }; delete filters[key];
    return '<a class="filter-chip" href="/sites/' + site.id + '?' + liveQuery({ ...range, filters }, days, comparison) + '&metric=' + metric +
      '" aria-label="' + escapeHtml('Remove ' + key + ' filter: ' + range.filters[key]) + '">' + escapeHtml(key + ': ' + range.filters[key]) + ' &times;</a>';
  }).join('');
  const filterBar = chips ? '<nav class="overview-filters" aria-label="Active visitor filters">' + chips +
    '<a class="report-link" href="/sites/' + site.id + '?' + liveQuery({ ...range, filters: {} }, days, comparison) + '&metric=' + metric + '">Clear all</a></nav>' +
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
    reportCard("Acquisition", selected[2].slice(0, 5), "No matching traffic in this period.", reportLink(selected[0]), rowLink(selected[0]), tabs) +
    reportCard("Top pages", analytics.paths.slice(0, 5), "Pages will appear after the first view.", reportLink("path"), rowLink("path")) + '</div>' + conversions;

}

export function overviewGoalsFragment(site, goals, range, days) {
  return goalCard(goals) + '<a class="report-link" href="/sites/' + site.id + '/conversions?' + liveQuery(range, days, false) + '">All goals and funnels &rarr;</a>';
}

export function conversionsPage(user, site, sites, goals, funnels, truncated, range) {
  return pageShell(site.name + " conversions", user,
    '<main class="shell website-dashboard" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) +
    '</p><h1>Conversions</h1><p class="dashboard-period">' + escapeHtml(range.label) + '</p></div><a class="button secondary" href="/sites/' +
    site.id + '?' + liveQuery(range, range.days || 7, false) + '">Back to overview</a></div><div class="conversions-workspace"><div>' +
    goalCard(goals) + '</div><div class="funnel-stack">' + funnelCard(funnels, truncated) + '</div></div></main>', site, sites);
}

function filterQuery(range) {
  let query = '';
  for (const key of Object.keys(range.filters || {})) query += '&' + key + '=' + encodeURIComponent(range.filters[key]);
  return query + '&acquisition=' + (range.acquisition || 'source');
}

function liveQuery(range, days, compare) {
  const base = range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days;
  let query = compare ? base + "&compare=1" : base;
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

export function goalCard(goals) {
  if (!goals.length) return "";
  const items = goals.map((goal) => {
    let hint = fmtInt(goal.unique_conversions) + " unique, " + oneDecimal(Number(goal.conversion_rate) * 100) + "% conversion rate";
    if (Number(goal.value)) hint += ", " + fmtInt(goal.value) + " value";
    return '<li><div class="row-label"><span class="truncate">' + escapeHtml(goal.name) + '</span><span class="value">' + fmtInt(goal.conversions) +
      '</span></div><p class="hint">' + escapeHtml(hint) + "</p></li>";
  }).join("");
  return '<section class="report" aria-labelledby="goals-title"><div class="report-head"><h2 id="goals-title">Goals</h2><span>Conversions</span></div><ol>' + items + "</ol></section>";
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

export function sitePage(user, site, sites, analytics, range, days, metric, origin, comparison) {
  const title = range.from ? range.from + " to " + range.to : days === 1 ? "Today" : "Last " + days + " days";
  const hasData = Number(analytics.summary.pageviews) > 0;
  const compareSuffix = comparison ? "&compare=1" : "";
  const statsBase = "/sites/" + site.id + "/partials/live?" + (range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days) + "&metric=" + metric + compareSuffix + filterQuery(range);
  const periodTabs = [1, 7, 30].map((period) =>
    '<a href="/sites/' + site.id + "?period=" + period + "&metric=" + metric + compareSuffix + filterQuery(range) + '"' + (!range.from && period === days ? ' aria-current="page"' : "") + ">" +
    (period === 1 ? "Today" : period + "d") + "</a>").join("");
  const snippet = '<script defer src="' + origin + "/js/" + site.public_key + '.js"></script>';
  const install = '<section class="card install" aria-labelledby="install-title"><h2 id="install-title">Install the tracker</h2><p>Paste this into the <code>&lt;head&gt;</code> of ' +
    escapeHtml(site.domain) + '.</p><div class="snippet" role="region" tabindex="0" aria-label="Tracker installation code"><code>' + escapeHtml(snippet) +
    '</code></div><button class="button secondary" type="button" data-copy-code>Copy code</button></section>';
  return pageShell(
    site.name + " analytics",
    user,
    '<main class="shell website-dashboard" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>Overview</h1><p class=\"dashboard-period\">" + escapeHtml(title) + "</p></div>" +
      '<div class="dashboard-controls"><a class="report-link comparison-control" href="/sites/' + site.id + '?' + liveQuery(range, days, !comparison) + '&metric=' + metric + '">' + (comparison ? 'Hide comparison' : 'Compare previous period') + '</a><div id="live-current" aria-live="polite"><span class="current"><span class="site-dot" aria-hidden="true"></span><strong id="live-current-value" data-current>' +
      fmtInt(analytics.current) + '</strong> online now</span></div><nav class="periods" aria-label="Date range">' + periodTabs + "</nav>" +
      '<details class="range-picker"><summary class="button secondary">Custom range</summary>' +
      '<form class="range-form" method="get" action="/sites/' + site.id + '"><input type="hidden" name="metric" value="' + escapeHtml(metric) + '">' +
      Object.keys(range.filters || {}).map((key) => '<input type="hidden" name="' + key + '" value="' + escapeHtml(range.filters[key]) + '">').join('') +
      '<input type="hidden" name="acquisition" value="' + (range.acquisition || 'source') + '">' +
      (comparison ? '<input type="hidden" name="compare" value="1">' : "") +
      '<label class="compact-field" for="range-from"><span>From</span><input id="range-from" name="from" type="date" required value="' + escapeHtml(range.from) + '"></label>' +
      '<label class="compact-field" for="range-to"><span>To</span><input id="range-to" name="to" type="date" required value="' + escapeHtml(range.to) + '"></label>' +
      '<button class="button secondary" type="submit">Apply</button></form></details></div></div>' +
      '<nav class="dashboard-navigation" aria-label="Website analytics"><a href="/sites/' + site.id + '/reports?cohort=1&' + liveQuery(range, days, false) + '">All reports</a><a href="/sites/' + site.id + '/reports/journeys?' + liveQuery(range, days, false) + '">Visitor journeys</a></nav><div id="live-stats" data-stats-url="' + statsBase + '" hx-get="' + statsBase + '" hx-trigger="every 5s" hx-sync="this:drop" hx-target="#live-stats" hx-swap="innerHTML">' +
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
  const status = scheduled ? (connected ? "Runner connected" : "Runner disconnected") : "Manual backups only";
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
    (!connected ? '<p class="backup-runner-note">Automatic backups need the server runner. Saving a schedule alone does not start it.</p>' : "") + '</section></div>' +
    '<section class="card backup-history"><div class="report-titlebar"><div><h2>Recent backups</h2><p class="hint">The 20 most recent attempts. Files remain on the server.</p></div></div>' +
    (rows ? '<div class="table-scroll" tabindex="0" role="region" aria-label="Backup history"><table class="data-table"><thead><tr><th scope="col">Created (UTC)</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Size</th></tr></thead><tbody>' + rows +
      '</tbody></table></div>' : '<div class="backup-history-empty"><p>No backups recorded yet.</p><p class="hint">Create a backup to see it here. Older files are still in the server&#39;s backups folder.</p></div>') + '</section>' +
    '<details class="backup-guide"><summary>Set up automatic backups and recovery</summary><div><h2>Connect the runner</h2><p>Use the included server timer or run the backup runner once a minute with cron. It reads the schedule you save above.</p>' +
    '<pre class="setup">python3 deploy/backup-runner.py --data-dir /var/lib/risulta-sprout</pre><p><a class="report-link" href="/backup-setup.txt">Open server setup instructions</a></p>' +
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
    return "/sites/" + site.id + "/reports?" + reportQuery(params);
  };
  const journeyLink = "/sites/" + site.id + "/reports/journeys?" + reportQuery(clearJourneyRange(range, days));
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
  const filterForm = '<form class="filter-grid" method="get" action="/sites/' + site.id + '/reports">' +
    (report.cohort ? '<input type="hidden" name="cohort" value="1">' : "") +
    '<input type="hidden" name="dimension" value="' + escapeHtml(report.dimension) + '">' +
    '<input type="hidden" name="period" value="' + escapeHtml(base.period) + '">' +
    (base.from ? '<input type="hidden" name="from" value="' + escapeHtml(base.from) + '"><input type="hidden" name="to" value="' + escapeHtml(base.to) + '">' : "") +
    filterFields +
    '<button class="button secondary" type="submit">Filter</button>' +
    '<a class="button secondary" href="/sites/' + site.id + "/reports?" + reportQuery(clearParams) + '">Clear</a></form>';
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
    return "/sites/" + site.id + "/reports?" + reportQuery(params);
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
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>Full report</h1><p class=\"dashboard-period\">" + escapeHtml(range.label) + '</p></div><a class="button secondary" href="/sites/' + site.id + '?' + liveQuery(range, days, false) + '">Back to overview</a></div>' +
      '<nav class="periods report-tabs" aria-label="Report dimension">' + tabs + '<a href="' + journeyLink + '">Visitor journeys</a></nav>' + filterForm +
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
    return "/sites/" + site.id + "/reports/journeys?" + reportQuery(base) +
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
    '<main class="shell journeys-page" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) +
    '</p><h1>Visitor journeys</h1><p class="journeys-intro">Follow the pages and events within each visit.</p></div><div class="actions"><a class="button secondary" href="/sites/' +
    site.id + "/reports?" + reportQuery(base) + '">Back to reports</a></div></div>' +
    '<div class="journeys-toolbar"><p><strong>' + fmtInt(report.total) + (report.truncated ? "+" : "") +
    (report.total === 1 ? " visit" : " visits") + '</strong><span>' + escapeHtml(range.label) + '</span></p>' +
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

export function settingsPage(session, site, sites, goals, funnels, error, origin) {
  const errorMessages = {
    "goal-name-required": "Enter a goal name.",
    "goal-event-invalid": "Use a valid event name.",
    "goal-path-invalid": "The path must start with /.",
    "goal-name-registered": "That goal name is already in use.",
    "funnel-name-required": "Enter a funnel name.",
    "funnel-steps-invalid": "Select at least two distinct goals of this site.",
    "funnel-save-failed": "Unable to save this funnel.",
  };
  const snippet = '<script defer src="' + origin + "/js/" + site.public_key + '.js"></script>';
  const trackerCard = '<section class="card settings-section install" aria-labelledby="tracker-title"><h2 id="tracker-title">Tracker code</h2>' +
    "<p>Paste this into the <code>&lt;head&gt;</code> of " + escapeHtml(site.domain) + ".</p>" +
    '<div class="snippet" role="region" tabindex="0" aria-label="Tracker installation code"><code>' + escapeHtml(snippet) + "</code></div>" +
    '<button class="button secondary" type="button" data-copy-code>Copy code</button></section>';
  const goalItems = goals.map((g) => "<li><strong>" + escapeHtml(g.name) + "</strong><span>" + escapeHtml(g.event_name) + (g.path ? " at " + escapeHtml(g.path) : "") + "</span></li>").join("");
  const goalCard = session.role === "admin"
    ? '<section class="card settings-section" aria-labelledby="goals-settings-title"><h2 id="goals-settings-title">Goals</h2><p class="hint">Track a custom event or a pageview at one exact path.</p>' +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/goals"><input type="hidden" name="csrf" value="' + session.csrf + '">' +
      '<div class="field"><label for="goal-name">Goal name</label><input id="goal-name" name="name" required maxlength="80" placeholder="Signup"></div>' +
      '<div class="field"><label for="goal-event">Event name</label><input id="goal-event" name="event_name" required maxlength="64" placeholder="signup or pageview"></div>' +
      '<div class="field"><label for="goal-path">Exact page path (optional)</label><input id="goal-path" name="path" maxlength="2048" placeholder="/pricing"></div>' +
      '<div class="actions"><button class="button" type="submit">Add goal</button></div></form>' +
      (goalItems ? '<details class="settings-items"><summary>' + goals.length + ' configured goals</summary><ol class="settings-list">' + goalItems + '</ol></details>' : "") + "</section>"
    : "";
  const funnelOptions = goals.map((g) => '<option value="' + g.id + '">' + escapeHtml(g.name) + "</option>").join("");
  const funnelItems = funnels.map((f) => "<li><strong>" + escapeHtml(f.name) + "</strong><span>" + f.steps.map((s) => escapeHtml(s.name)).join(" &rarr; ") + "</span></li>").join("");
  const funnelCard = session.role === "admin" && goals.length >= 2
    ? '<section class="card settings-section" aria-labelledby="funnels-settings-title"><h2 id="funnels-settings-title">Funnels</h2><p class="hint">Select goals in the order visitors should complete them.</p>' +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/funnels"><input type="hidden" name="csrf" value="' + session.csrf + '">' +
      '<div class="field"><label for="funnel-name">Funnel name</label><input id="funnel-name" name="name" required maxlength="100"></div>' +
      '<div class="field"><label for="funnel-goal-1">Step 1</label><select id="funnel-goal-1" name="goal" required><option value="">Select a goal</option>' + funnelOptions + "</select></div>" +
      '<div class="field"><label for="funnel-goal-2">Step 2</label><select id="funnel-goal-2" name="goal" required><option value="">Select a goal</option>' + funnelOptions + "</select></div>" +
      '<div class="field"><label for="funnel-goal-3">Step 3 (optional)</label><select id="funnel-goal-3" name="goal"><option value="">No third step</option>' + funnelOptions + "</select></div>" +
      '<div class="actions"><button class="button" type="submit">Add funnel</button></div></form>' +
      (funnelItems ? '<details class="settings-items"><summary>' + funnels.length + ' configured funnels</summary><ol class="settings-list">' + funnelItems + '</ol></details>' : "") + "</section>"
    : "";
  const errorMessage = errorMessages[error] || "";
  return pageShell(
    site.name + " settings",
    session,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>Website settings</h1></div></div>" +
      (errorMessage ? '<p class="error" role="alert">' + escapeHtml(errorMessage) + "</p>" : "") +
      '<div class="settings-workspace">' + trackerCard + goalCard + funnelCard + '</div></main>',
    site,
    sites,
  );
}
