/* Risulta Sprout polling dashboard. No dependencies. Polls the site stats
 * endpoint every 5 seconds, pauses while the tab is hidden, and backs off
 * exponentially on errors (5s, 10s, 20s, up to 60s). */
(function () {
  "use strict";
  var root = document.getElementById("live-stats");
  if (!root) return;
  var baseUrl = root.getAttribute("data-stats-url") || "";
  var status = document.getElementById("poll-status");
  var timer = null;
  var failures = 0;

  function setStatus(state, text) {
    if (!status) return;
    status.setAttribute("data-state", state);
    status.textContent = text;
  }

  function esc(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function table(title, rows, valueLabel) {
    if (!rows.length) return "<h3>" + esc(title) + "</h3><p>No data yet.</p>";
    var html = "<h3>" + esc(title) + "</h3><table><thead><tr><th>" + esc(title) +
      '</th><th class="num">Visitors</th><th class="num">Pageviews</th>';
    if (valueLabel) html += '<th class="num">' + esc(valueLabel) + "</th>";
    html += "</tr></thead><tbody>";
    rows.forEach(function (r) {
      html += "<tr><td>" + esc(r.label) + '</td><td class="num">' + r.visitors +
        '</td><td class="num">' + r.pageviews + "</td>";
      if (valueLabel) html += '<td class="num">' + esc(r.value || 0) + "</td>";
      html += "</tr>";
    });
    return html + "</tbody></table>";
  }

  function render(data) {
    var s = data.summary || { pageviews: 0, visitors: 0, visits: 0 };
    var html = '<div class="cards">' +
      '<div class="card"><strong>' + s.visitors + "</strong><span>visitors</span></div>" +
      '<div class="card"><strong>' + s.pageviews + "</strong><span>pageviews</span></div>" +
      '<div class="card"><strong>' + s.visits + "</strong><span>visits</span></div></div>";
    html += table("Pages", data.paths || []);
    html += table("Sources", data.sources || []);
    var goals = data.goals || [];
    if (goals.length) {
      html += "<h3>Goals</h3><table><thead><tr><th>Goal</th>" +
        '<th class="num">Conversions</th><th class="num">Unique</th>' +
        '<th class="num">Rate</th></tr></thead><tbody>';
      goals.forEach(function (g) {
        var pct = (100 * (g.conversion_rate || 0)).toFixed(1) + "%";
        html += "<tr><td>" + esc(g.name) + " (" + esc(g.event_name) + ")" +
          '</td><td class="num">' + g.conversions + '</td><td class="num">' +
          g.unique_conversions + '</td><td class="num">' + pct + "</td></tr>";
      });
      html += "</tbody></table>";
    }
    var days = data.byDay || [];
    if (days.length) {
      html += "<h3>By day</h3><table><thead><tr><th>Day</th>" +
        '<th class="num">Visitors</th><th class="num">Pageviews</th></tr></thead><tbody>';
      days.forEach(function (d) {
        html += "<tr><td>" + esc(d.day) + '</td><td class="num">' + d.visitors +
          '</td><td class="num">' + d.pageviews + "</td></tr>";
      });
      html += "</tbody></table>";
    }
    root.innerHTML = html;
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
        setStatus("live", "Live, updated " + new Date().toLocaleTimeString());
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

  var periodLinks = document.querySelectorAll("[data-period]");
  periodLinks.forEach(function (link) {
    link.addEventListener("click", function (ev) {
      ev.preventDefault();
      baseUrl = link.getAttribute("href");
      failures = 0;
      poll();
    });
  });

  poll();
})();
