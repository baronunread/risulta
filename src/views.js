// Server-rendered pages. Markup follows lib/views.js class names so the
// same stylesheet renders both apps.
import { chart, dateSeries, hourSeries } from "./chart.js";
import { avatarFor } from "./avatar.js";
import { escapeHtml, fmtInt } from "./util.js";

export function trackerFor(publicKey) {
  return (
    "/*! Risulta tracker - MIT */(()=>{let l=\"\";const s=document.currentScript,e=new URL(\"/api/event/" +
    publicKey +
    "\",s.src).href,p=(n,v)=>fetch(e,{method:\"POST\",mode:\"cors\",keepalive:true,headers:{\"Content-Type\":\"text/plain\"},body:JSON.stringify({name:n,path:location.pathname+location.search,referrer:document.referrer,domain:location.hostname,value:v})}).catch(()=>{}),f=()=>{const p=location.pathname+location.search;if(p===l)return;l=p;return(window.risulta??={}).track(\"pageview\")};for(const k of[\"pushState\",\"replaceState\"]){const o=history[k];history[k]=function(){const r=o.apply(this,arguments);f();return r}}(window.risulta??={}).track=p;addEventListener(\"popstate\",f);addEventListener(\"pageshow\",e=>{if(e.persisted){l=\"\";f()}});f()})();"
  );
}

const MARK = '<span class="mark" aria-hidden="true"><i></i><i></i></span>';
const GEAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0 1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 0 0 2.572-1.065"/><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0"/></svg>';

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
  return '<header class="topbar"><div class="shell topbar-inner"><a class="brand" href="/">' + MARK + "<span>Risulta</span></a>" + switcher +
    '<nav class="nav" aria-label="Account"><details class="account-menu"><summary><span class="avatar" aria-hidden="true">' + avatarFor(user.display_name || user.email) + '</span><span class="account-trigger-email">' + escapeHtml(user.email) + "</span></summary>" +
    '<div class="account-panel"><span class="account-email">' + escapeHtml(user.email) + '</span><a href="/">Websites</a><a href="/account">Account settings</a>' +
    (user.role === "admin" ? '<a href="/users">Users</a>' : "") +
    '<form method="post" action="/logout"><input type="hidden" name="csrf" value="' + user.csrf + '"><button class="link-button" type="submit">Log out</button></form>' +
    "</div></details></nav></div></header>";
}

export function pageShell(title, user, body, site, sites) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">' +
    '<link rel="stylesheet" href="/style.css">' +
    "<title>" + escapeHtml(title) + " - Risulta</title>" +
    '<script src="/htmx.min.js"></script><script src="/dashboard.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a>' +
    (user ? topbar(user, site || null, sites || []) : "") + body +
    (user ? '<footer class="footer"><div class="shell"><span><strong>Risulta Sprout</strong> standalone analytics</span></div></footer>' : "") +
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
    ? '<ol class="site-list">' + sites.map((s) =>
      '<li><a class="site-link" href="/sites/' + s.id + '"><span><strong>' + escapeHtml(s.name) + '</strong><span class="site-domain">' + escapeHtml(s.domain) +
      '</span></span><span class="arrow" aria-hidden="true">&rarr;</span>' +
      '<span class="site-overview" aria-label="Last 7 days"><span><strong>' + fmtInt(s.overview.visitors) + "</strong>visitors</span>" +
      "<span><strong>" + fmtInt(s.overview.pageviews) + "</strong>views</span></span></a></li>").join("") + "</ol>"
    : '<div class="empty-card"><h2>No websites yet</h2><p>Add your first website to start collecting private analytics.</p></div>';
  return pageShell(
    "Websites",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Workspace</p><h1>Your websites</h1></div>' +
      (user.role === "admin"
        ? '<div class="actions"><a class="button" href="/sites/new">Add website</a></div>'
        : "") + "</div>" +
      '<section aria-label="Websites">' + cards + "</section></main>",
    null,
    sites,
  );
}

export function newSitePage(user, error) {
  return pageShell(
    "Add website",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Website administration</p><h1>Add a website</h1></div></div>' +
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
  const visitorLabel = days === 1 ? "Unique visitors today" : "Unique visitor-days";
  const metricLabel = metric === "pageviews" ? "Pageviews" : metric === "visits" ? "Visits" : visitorLabel;
  const hasData = Number(metrics.pageviews) > 0;
  const series = days === 1 ? hourSeries(analytics.byHour) : dateSeries(days, analytics.byDay);
  const metricTabs = [["visitors", visitorLabel], ["visits", "Visits"], ["pageviews", "Pageviews"]].map((tab) =>
    '<a href="/sites/' + site.id + "?" + liveQuery(range, days, comparison) + "&metric=" + tab[0] + '"' + (metric === tab[0] ? ' aria-current="page"' : "") + ">" + escapeHtml(tab[1]) + "</a>").join("");
  const pageQuery = liveQuery(range, days, null);
  const reportLinks = '<a class="footer-link" href="/api/sites/' + site.id + "/report?" + pageQuery + '&dimension=path">JSON</a> &middot; <a class="footer-link" href="/api/sites/' + site.id + "/report?" + pageQuery + '&dimension=path&format=csv">CSV</a>';
  const toggleQuery = liveQuery(range, days, !comparison);
  const comparisonLabel = comparison
    ? '<p class="hint metrics-note">Previous period: ' + fmtInt(comparison[metric === "pageviews" ? "pageviews" : metric === "visits" ? "visits" : "visitors"]) + " " + escapeHtml(metricLabel.toLowerCase()) + ".</p>"
    : "";
  return '<section class="panel" aria-label="Traffic summary"><div class="metrics">' +
    '<div class="metric"><span>' + escapeHtml(visitorLabel) + '</span><strong data-metric="visitors">' + fmtInt(metrics.visitors) + "</strong></div>" +
    '<div class="metric"><span>Total visits</span><strong data-metric="visits">' + fmtInt(metrics.visits) + "</strong></div>" +
    '<div class="metric"><span>Total pageviews</span><strong data-metric="pageviews">' + fmtInt(metrics.pageviews) + "</strong></div>" +
    '<div class="metric"><span>Views per visit</span><strong data-metric="views-per-visit">' + viewsPerVisit.toFixed(2) + "</strong></div></div>" +
    (hasData
      ? '<div class="chart-wrap"><nav class="periods" aria-label="Chart metric">' + metricTabs + "</nav>" + chart(series, metric === "visitors" ? "visitors" : metric, metricLabel) +
        '<a class="footer-link" href="/sites/' + site.id + "?" + toggleQuery + "&metric=" + metric + '">' + (comparison ? "Hide comparison" : "Compare previous period") + "</a>" + comparisonLabel + "</div>"
      : '<div class="empty"><h2>Waiting for the first visitor</h2><p>Install the tracker below. New visits will appear here live.</p></div>') +
    "</section>" +
    '<p class="hint metrics-note">Visitor identities reset at each UTC day. Multi-day totals are unique visitor-days, not deduplicated people. <span class="status" id="poll-status" data-state="live">Live.</span></p>' +
    '<div id="dashboard-reports" class="reports">' + goalCard(analytics.goals) + funnelCard(analytics.funnels, analytics.funnelsTruncated) +
    reportCard("Top pages", analytics.paths, "Pages will appear after the first view.", reportLinks) +
    reportCard("Top sources", analytics.referrers, "Sources will appear after the first visit.", reportLinks) +
    reportCard("Top mediums", analytics.mediums, "Mediums will appear after tagged visits.", reportLinks) +
    reportCard("Top campaigns", analytics.campaigns, "Campaigns will appear after tagged visits.", reportLinks) +
    "</div>";
}

function liveQuery(range, days, compare) {
  const base = range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days;
  return compare ? base + "&compare=1" : base;
}

export function reportCard(title, rows, emptyLabel, detailLinks) {
  let max = 1;
  for (let i = 0; i < rows.length; i++) max = Math.max(max, Number(rows[i].visitors));
  const items = rows.length
    ? "<ol>" + rows.map((row) => {
      const width = Math.max(2, (Number(row.visitors) / max) * 100).toFixed(1);
      return '<li><div class="row-label"><span class="truncate" title="' + escapeHtml(row.label) + '">' + escapeHtml(row.label) +
        '</span><span class="value">' + fmtInt(row.visitors) + '</span></div><div class="meter" aria-hidden="true"><span style="width:' + width + '%"></span></div></li>';
    }).join("") + "</ol>"
    : '<p class="empty-small">' + escapeHtml(emptyLabel) + "</p>";
  const id = title.toLowerCase().replace(/ /g, "-");
  return '<section class="report" aria-labelledby="' + id + '"><div class="report-head"><h2 id="' + id + '">' + escapeHtml(title) + "</h2><span>" + detailLinks + "</span></div>" + items + "</section>";
}

export function goalCard(goals) {
  if (!goals.length) return "";
  const items = goals.map((goal) => {
    let hint = fmtInt(goal.unique_conversions) + " unique, " + (Number(goal.conversion_rate) * 100).toFixed(1) + "% conversion rate";
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
  return items + (truncated ? '<p class="hint metrics-note">Funnel counts scan the 50,000 most recent events in range and are approximate on larger ranges.</p>' : "");
}

export function sitePage(user, site, sites, analytics, range, days, metric, origin, comparison) {
  const title = range.from ? range.from + " to " + range.to : days === 1 ? "Today" : "Last " + days + " days";
  const hasData = Number(analytics.summary.pageviews) > 0;
  const compareSuffix = comparison ? "&compare=1" : "";
  const statsBase = "/sites/" + site.id + "/partials/live?" + (range.from ? "from=" + range.from + "&to=" + range.to : "period=" + days) + "&metric=" + metric + compareSuffix;
  const periodTabs = [1, 7, 30].map((period) =>
    '<a href="/sites/' + site.id + "?period=" + period + "&metric=" + metric + compareSuffix + '"' + (!range.from && period === days ? ' aria-current="page"' : "") + ">" +
    (period === 1 ? "Today" : period + "d") + "</a>").join("");
  const snippet = '<script defer src="' + origin + "/js/" + site.public_key + '.js"></script>';
  const install = '<section class="card install" aria-labelledby="install-title"><h2 id="install-title">Install the tracker</h2><p>Paste this into the <code>&lt;head&gt;</code> of ' +
    escapeHtml(site.domain) + '.</p><div class="snippet" role="region" tabindex="0" aria-label="Tracker installation code"><code>' + escapeHtml(snippet) +
    '</code></div><button class="button secondary" type="button" data-copy-code>Copy code</button><p class="hint" id="copy-status" role="status" aria-live="polite"></p></section>';
  return pageShell(
    site.name + " analytics",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>" + escapeHtml(title) + "</h1></div>" +
      '<div class="dashboard-controls"><div id="live-current" aria-live="polite"><span class="current"><span class="site-dot" aria-hidden="true"></span><strong data-current>' +
      fmtInt(analytics.current) + '</strong> current</span></div><nav class="periods" aria-label="Date range">' + periodTabs + "</nav>" +
      '<details class="range-picker"><summary class="button secondary">Custom range</summary>' +
      '<form class="range-form" method="get" action="/sites/' + site.id + '"><input type="hidden" name="metric" value="' + escapeHtml(metric) + '">' +
      (comparison ? '<input type="hidden" name="compare" value="1">' : "") +
      '<label class="compact-field" for="range-from"><span>From</span><input id="range-from" name="from" type="date" required value="' + escapeHtml(range.from) + '"></label>' +
      '<label class="compact-field" for="range-to"><span>To</span><input id="range-to" name="to" type="date" required value="' + escapeHtml(range.to) + '"></label>' +
      '<button class="button secondary" type="submit">Apply</button></form></details></div></div>' +
      '<div id="live-stats" data-stats-url="' + statsBase + '" hx-get="' + statsBase + '" hx-trigger="every 5s" hx-target="#live-stats" hx-swap="innerHTML">' +
      liveFragment(site, analytics, range, days, metric, comparison) +
      "</div>" + (hasData ? "" : install) + "</main>",
    site,
    sites,
  );
}

export function usersPage(admin, users, sites) {
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
      '<ol class="user-list">' + records + "</ol></section></div></main>",
    null,
    [],
  );
}

export function accountPage(user, options) {
  const settings = options || {};
  const profileMessages = {
    "1": '<p class="success" role="status">Profile updated.</p>',
    "name-required": '<p class="error" role="alert">Enter your display name.</p>',
    "email-invalid": '<p class="error" role="alert">Enter a valid email address.</p>',
    "email-registered": '<p class="error" role="alert">That email address is already in use.</p>',
  };
  const profileMessage = profileMessages[settings.profile] || "";
  const displayName = user.display_name || user.email.split("@")[0];
  return pageShell(
    "Account settings",
    user,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">Account</p><h1>Account settings</h1></div></div>' +
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
  const base = { dimension: report.dimension, period: String(days), limit: String(report.limit), offset: String(report.offset), sort: report.sort };
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
    const params = { dimension: dimension, period: base.period, limit: base.limit, offset: "0", sort: base.sort };
    if (base.from) {
      params.from = base.from;
      params.to = base.to;
    }
    for (let i = 0; i < filterNames.length; i++) {
      if (base[filterNames[i]]) params[filterNames[i]] = base[filterNames[i]];
    }
    return "/sites/" + site.id + "/reports?" + reportQuery(params);
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
  const filterForm = '<form class="filter-grid" method="get" action="/sites/' + site.id + '/reports">' +
    '<input type="hidden" name="dimension" value="' + escapeHtml(report.dimension) + '">' +
    '<input type="hidden" name="period" value="' + escapeHtml(base.period) + '">' +
    (base.from ? '<input type="hidden" name="from" value="' + escapeHtml(base.from) + '"><input type="hidden" name="to" value="' + escapeHtml(base.to) + '">' : "") +
    filterFields +
    '<button class="button secondary" type="submit">Filter</button>' +
    '<a class="button secondary" href="/sites/' + site.id + "/reports?" + reportQuery(clearParams) + '">Clear</a></form>';
  const rows = report.rows.map(function (row) {
    return "<tr><td>" + escapeHtml(row.label) + "</td><td>" + fmtInt(row.pageviews) + "</td><td>" + fmtInt(row.visitors) + "</td><td>" + fmtInt(row.value) + "</td></tr>";
  }).join("");
  const previous = Math.max(0, report.offset - report.limit);
  const next = report.offset + report.limit;
  const pageParams = function (offset) {
    const params = { dimension: base.dimension, period: base.period, limit: base.limit, offset: String(offset), sort: base.sort };
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
  const csvParams = { dimension: base.dimension, period: base.period, limit: base.limit, offset: base.offset, sort: base.sort };
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
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>Full report</h1></div></div>" +
      '<nav class="periods report-tabs" aria-label="Report dimension">' + tabs + "</nav>" + filterForm +
      '<section class="card report-table-card" aria-labelledby="report-title"><div class="report-titlebar"><div><h2 id="report-title">' + escapeHtml(title) + '</h2><p class="hint">' +
      fmtInt(report.total) + " row" + (report.total === 1 ? "" : "s") + "</p></div></div>" +
      (report.rows.length
        ? '<div class="table-scroll" tabindex="0" role="region" aria-label="Report results"><table class="data-table"><thead><tr><th scope="col">Label</th><th scope="col">Pageviews</th><th scope="col">Visitors</th><th scope="col">Value</th></tr></thead><tbody>' +
          rows + "</tbody></table></div>"
        : '<p class="empty-small">No matching rows. Adjust the range or filters.</p>') +
      '<div class="report-footer"><p><a class="footer-link" href="/api/sites/' + site.id + "/report?" + reportQuery(csvParams) + '&format=csv">Download CSV</a></p>' + pageLinks + "</div></section></main>",
    null,
    sites,
  );
}

function reportQuery(params) {
  const names = ["dimension", "period", "from", "to", "limit", "offset", "sort", "path", "source", "medium", "campaign", "event"];
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
  const trackerCard = '<section class="card settings-section" aria-labelledby="tracker-title"><h2 id="tracker-title">Tracker code</h2>' +
    "<p class=\"hint\">Paste this into the <code>&lt;head&gt;</code> of " + escapeHtml(site.domain) + ".</p>" +
    '<div class="snippet" role="region" tabindex="0" aria-label="Tracker installation code"><code>' + escapeHtml(snippet) + "</code></div>" +
    '<button class="button secondary" type="button" data-copy-code>Copy code</button><p class="hint" id="copy-status" role="status" aria-live="polite"></p></section>';
  const goalItems = goals.map((g) => "<li><strong>" + escapeHtml(g.name) + "</strong><span>" + escapeHtml(g.event_name) + (g.path ? " at " + escapeHtml(g.path) : "") + "</span></li>").join("");
  const goalCard = session.role === "admin"
    ? '<section class="card settings-section" aria-labelledby="goals-settings-title"><h2 id="goals-settings-title">Goals</h2><p class="hint">Track a custom event or a pageview at one exact path.</p>' +
      '<form class="form" method="post" action="/api/sites/' + site.id + '/goals"><input type="hidden" name="csrf" value="' + session.csrf + '">' +
      '<div class="field"><label for="goal-name">Goal name</label><input id="goal-name" name="name" required maxlength="80" placeholder="Signup"></div>' +
      '<div class="field"><label for="goal-event">Event name</label><input id="goal-event" name="event_name" required maxlength="64" placeholder="signup or pageview"></div>' +
      '<div class="field"><label for="goal-path">Exact page path (optional)</label><input id="goal-path" name="path" maxlength="2048" placeholder="/pricing"></div>' +
      '<div class="actions"><button class="button" type="submit">Add goal</button></div></form>' +
      (goalItems ? '<ol class="site-list">' + goalItems + "</ol>" : "") + "</section>"
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
      (funnelItems ? '<ol class="site-list">' + funnelItems + "</ol>" : "") + "</section>"
    : "";
  const errorMessage = errorMessages[error] || "";
  return pageShell(
    site.name + " settings",
    session,
    '<main class="shell" id="main"><div class="titlebar"><div><p class="eyebrow">' + escapeHtml(site.domain) + "</p><h1>Website settings</h1></div></div>" +
      (errorMessage ? '<p class="error" role="alert">' + escapeHtml(errorMessage) + "</p>" : "") +
      trackerCard + goalCard + funnelCard + "</main>",
    site,
    sites,
  );
}
