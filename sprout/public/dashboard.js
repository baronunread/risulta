/* Risulta Sprout live updates. No dependencies. Polls the site stats
 * endpoint every 5 seconds, pauses while the tab is hidden, and backs off
 * exponentially on errors (5s, 10s, 20s, up to 60s). Numbers refresh in
 * place; the server-rendered chart refreshes on navigation. Also wires the
 * tracker copy button. */
(function () {
  "use strict";

  function fmtInt(n) {
    var neg = Number(n) < 0;
    var s = String(Math.floor(Math.abs(Number(n)) || 0));
    var out = "";
    while (s.length > 3) {
      out = "," + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return (neg ? "-" : "") + s + out;
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Tracker copy buttons (static pages only; no framework needed).
  document.querySelectorAll("[data-copy-code]").forEach(function (button) {
    button.addEventListener("click", function () {
      var region = button.parentElement.querySelector(".snippet code");
      var status = document.getElementById("copy-status");
      var done = function (ok) {
        if (status) status.textContent = ok ? "Copied." : "Copy failed.";
      };
      if (!region) return done(false);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(region.textContent).then(function () {
          done(true);
        }, function () {
          done(false);
        });
      } else {
        done(false);
      }
    });
  });

  var root = document.getElementById("live-stats");
  if (!root) return;
  var baseUrl = root.getAttribute("data-stats-url") || "";
  var siteId = root.getAttribute("data-site-id") || "";
  var rangeQuery = root.getAttribute("data-range-query") || "period=7";
  var status = document.getElementById("poll-status");
  var timer = null;
  var failures = 0;

  function setStatus(state, text) {
    if (!status) return;
    status.setAttribute("data-state", state);
    status.textContent = text;
  }

  function setMetric(name, value) {
    var el = root.querySelector('[data-metric="' + name + '"]');
    if (el) el.textContent = value;
  }

  function reportCard(title, rows, emptyLabel) {
    var max = 1;
    rows.forEach(function (r) {
      max = Math.max(max, Number(r.visitors));
    });
    var id = title.toLowerCase().replace(/ /g, "-");
    var html =
      '<section class="report" aria-labelledby="' + id + '"><div class="report-head"><h2 id="' + id + '">' +
      esc(title) + "</h2><span>" + reportLinks() + "</span></div>";
    if (!rows.length) return html + '<p class="empty-small">' + esc(emptyLabel) + "</p></section>";
    html += "<ol>";
    rows.forEach(function (r) {
      var width = Math.max(2, (Number(r.visitors) / max) * 100).toFixed(1);
      html +=
        '<li><div class="row-label"><span class="truncate" title="' + esc(r.label) + '">' + esc(r.label) +
        '</span><span class="value">' + fmtInt(r.visitors) + '</span></div><div class="meter" aria-hidden="true"><span style="width:' +
        width + '%"></span></div></li>';
    });
    return html + "</ol></section>";
  }

  function reportLinks() {
    var base = "/api/sites/" + siteId + "/report?" + rangeQuery + "&dimension=path";
    return '<a class="footer-link" href="' + base + '">JSON</a> · <a class="footer-link" href="' + base + '&format=csv">CSV</a>';
  }

  function goalCard(goals) {
    if (!goals.length) return "";
    var html = '<section class="report" aria-labelledby="goals-title"><div class="report-head"><h2 id="goals-title">Goals</h2><span>Conversions</span></div><ol>';
    goals.forEach(function (g) {
      var hint = fmtInt(g.unique_conversions) + " unique, " + (Number(g.conversion_rate) * 100).toFixed(1) + "% conversion rate";
      if (Number(g.value)) hint += ", " + fmtInt(g.value) + " value";
      html +=
        '<li><div class="row-label"><span class="truncate">' + esc(g.name) + '</span><span class="value">' + fmtInt(g.conversions) +
        "</span></div><p class=\"hint\">" + esc(hint) + "</p></li>";
    });
    return html + "</ol></section>";
  }

  function render(data) {
    var s = data.summary || { pageviews: 0, visitors: 0, visits: 0 };
    var vpv = Number(s.visits) ? Number(s.pageviews) / Number(s.visits) : 0;
    setMetric("visitors", fmtInt(s.visitors));
    setMetric("visits", fmtInt(s.visits));
    setMetric("pageviews", fmtInt(s.pageviews));
    setMetric("views-per-visit", vpv.toFixed(2));
    var current = root.querySelector("[data-current]");
    if (current) current.textContent = fmtInt(data.current || 0);
    var reports = document.getElementById("dashboard-reports");
    if (reports) {
      reports.innerHTML =
        goalCard(data.goals || []) +
        reportCard("Top pages", data.paths || [], "Pages will appear after the first view.") +
        reportCard("Top sources", data.referrers || [], "Sources will appear after the first visit.") +
        reportCard("Top mediums", data.mediums || [], "Mediums will appear after tagged visits.") +
        reportCard("Top campaigns", data.campaigns || [], "Campaigns will appear after tagged visits.");
    }
  }

  function delay() {
    if (failures === 0) return 5000;
    return Math.min(60000, 5000 * Math.pow(2, failures));
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(poll, delay());
  }

  function poll() {
    timer = null;
    if (document.hidden) {
      schedule();
      return;
    }
    fetch(baseUrl, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        failures = 0;
        render(data);
        setStatus("live", "Live.");
        schedule();
      })
      .catch(function (err) {
        failures += 1;
        setStatus("error", "Update failed (" + err.message + "), retrying.");
        schedule();
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && !timer) poll();
  });

  poll();
})();
