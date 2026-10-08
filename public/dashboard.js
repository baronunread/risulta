/* Risulta Sprout browser glue. Live numbers arrive through htmx polling
 * (hx-get on #live-stats); this file only wires the tracker copy button
 * and reports poll health. No dependencies besides htmx. */
(function () {
  "use strict";

  function pollStatus() {
    return document.getElementById("poll-status");
  }

  function setStatus(state, text) {
    var status = pollStatus();
    if (!status) return;
    status.setAttribute("data-state", state);
    status.textContent = text;
  }

  // Toasts double as the accessible live region: one visible, announced node
  // instead of a separate visual toast plus a hidden sr-only echo.
  var toastTimer = null;
  function showToast(text) {
    var toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.remove();
    }, 2400);
  }

  // Tracker copy buttons are outside the live refresh region.
  document.body.addEventListener("click", function (event) {
      var button = event.target.closest("[data-copy-code]");
      if (!button) return;
      var region = button.parentElement.querySelector(".snippet code");
      var code = button.getAttribute("data-copy-value") || (region && region.textContent);
      var done = function (ok) {
        showToast(ok ? "Copied to clipboard." : "Copy failed.");
      };
      if (!code) return done(false);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () {
          done(true);
        }, function () {
          done(false);
        });
      } else {
        done(false);
      }
  });

  var dropdownSelector = ".site-switcher[open], .account-menu[open], .range-picker[open]";
  document.body.addEventListener("pointerdown", function (event) {
    document.querySelectorAll(dropdownSelector).forEach(function (dropdown) {
      if (!dropdown.contains(event.target)) dropdown.open = false;
    });
  });
  document.body.addEventListener("focusin", function (event) {
    document.querySelectorAll(dropdownSelector).forEach(function (dropdown) {
      if (!dropdown.contains(event.target)) dropdown.open = false;
    });
  });
  document.body.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    document.querySelectorAll(dropdownSelector).forEach(function (dropdown) {
      var focused = dropdown.contains(document.activeElement);
      dropdown.open = false;
      if (focused) dropdown.querySelector("summary").focus();
    });
  });

  // Flash messages rendered once after a redirect (e.g. "Profile updated.").
  document.querySelectorAll("[data-toast]").forEach(function (el) {
    showToast(el.textContent);
    el.remove();
  });

  // Native submission remains available when JavaScript is disabled.
  var backupForm = document.querySelector("[data-backup-form]");
  if (backupForm) {
    var backupToast = document.querySelector("[data-backup-toast]");
    var backupFeedback = document.querySelector("[data-backup-feedback]");
    var backupTimer = null;
    function backupStatus(text) {
      backupFeedback.textContent = text;
      backupToast.className = "toast";
      backupToast.textContent = text;
      clearTimeout(backupTimer);
      backupTimer = setTimeout(function () {
        backupToast.textContent = "";
        backupToast.className = "";
      }, 10000);
    }
    if (backupFeedback.textContent) {
      setTimeout(function () { backupStatus(backupFeedback.textContent); }, 100);
    }
    backupForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = backupForm.querySelector("button");
      if (button.disabled) return;
      button.disabled = true;
      backupStatus("Creating database backup...");
      try {
        var response = await fetch(backupForm.action, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf: backupForm.elements.csrf.value }).toString()
        });
        var result = await response.json();
        if (response.ok && result.ok && result.path && result.bytes > 0) {
          backupStatus("Backup created: " + result.path + " (" + result.bytes + " bytes). Copy it off the server for safekeeping.");
        } else if (response.status === 401) {
          backupStatus("Your session has expired. Sign in again before creating a backup.");
        } else if (response.status === 403) {
          backupStatus("Backup was not created. Reload this page and check that you are signed in as an administrator.");
        } else {
          backupStatus("Database backup failed. Try again or check the server logs.");
        }
      } catch {
        backupStatus("Could not confirm the backup. Check the server's backups directory before trying again.");
      } finally {
        button.disabled = false;
      }
    });
  }

  // Inspect the nearest interval without requesting data or rebuilding the chart.
  var chartTooltip = null;
  var inspectedChart = null;
  var inspectedPoint = null;
  var pointerFrame = null;
  var pendingPointer = null;
  function hideChartTooltip() {
    if (pointerFrame !== null) cancelAnimationFrame(pointerFrame);
    pointerFrame = null;
    pendingPointer = null;
    if (chartTooltip) chartTooltip.hidden = true;
    if (inspectedChart) inspectedChart.classList.remove("is-inspecting");
    if (inspectedPoint) inspectedPoint.classList.remove("is-active");
    inspectedChart = null;
    inspectedPoint = null;
  }
  function showChartPoint(chart, point, clientX, clientY, drift) {
    if (!chartTooltip) {
      chartTooltip = document.createElement("div");
      chartTooltip.className = "chart-tooltip";
      chartTooltip.hidden = true;
      chartTooltip.setAttribute("role", "tooltip");
      var date = document.createElement("span");
      var value = document.createElement("strong");
      chartTooltip.append(date, value);
      document.body.appendChild(chartTooltip);
    }
    if (inspectedChart && inspectedChart !== chart) inspectedChart.classList.remove("is-inspecting");
    if (inspectedPoint) inspectedPoint.classList.remove("is-active");
    inspectedChart = chart;
    inspectedPoint = point;
    chart.classList.add("is-inspecting");
    point.classList.add("is-active");
    var guide = chart.querySelector(".chart-guide");
    guide.setAttribute("x1", point.getAttribute("cx"));
    guide.setAttribute("x2", point.getAttribute("cx"));
    chartTooltip.children[0].textContent = point.getAttribute("data-date");
    chartTooltip.children[1].textContent = point.getAttribute("data-count") + " " + point.getAttribute("data-metric-label").toLowerCase();
    chartTooltip.classList.toggle("is-drifting", drift === true && !chartTooltip.hidden);
    chartTooltip.hidden = false;
    var box = chartTooltip.getBoundingClientRect();
    var left = clientX + 16;
    var top = clientY - box.height - 16;
    if (left + box.width > window.innerWidth - 8) left = clientX - box.width - 16;
    if (top < 8) top = clientY + 16;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8));
    chartTooltip.style.transform = "translate3d(" + left + "px," + top + "px,0)";
  }
  function inspectPointer(event) {
    var chart = event.target.closest("svg.chart");
    if (!chart) return;
    var matrix = chart.getScreenCTM();
    if (!matrix) return;
    var coordinate = chart.createSVGPoint();
    coordinate.x = event.clientX;
    coordinate.y = event.clientY;
    coordinate = coordinate.matrixTransform(matrix.inverse());
    var points = chart.querySelectorAll(".chart-point");
    var nearest = null;
    var distance = Infinity;
    points.forEach(function (point) {
      var delta = Math.abs(Number(point.getAttribute("cx")) - coordinate.x);
      if (delta < distance) { distance = delta; nearest = point; }
    });
    if (nearest) showChartPoint(chart, nearest, event.clientX, event.clientY, event.pointerType !== "touch");
  }
  document.body.addEventListener("pointermove", function (event) {
    if (!event.target.closest("svg.chart")) return;
    pendingPointer = event;
    if (pointerFrame !== null) return;
    pointerFrame = requestAnimationFrame(function () {
      pointerFrame = null;
      if (pendingPointer) inspectPointer(pendingPointer);
      pendingPointer = null;
    });
  });
  document.body.addEventListener("pointerdown", function (event) {
    if (event.target.closest("svg.chart")) inspectPointer(event);
    else hideChartTooltip();
  });
  document.body.addEventListener("pointerout", function (event) {
    var chart = event.target.closest("svg.chart");
    if (chart && (!event.relatedTarget || !chart.contains(event.relatedTarget))) hideChartTooltip();
  });
  document.body.addEventListener("focusin", function (event) {
    var point = event.target.closest(".chart-point");
    if (!point) return;
    var box = point.getBoundingClientRect();
    showChartPoint(point.closest("svg.chart"), point, box.left + box.width / 2, box.top);
  });
  document.body.addEventListener("focusout", function (event) {
    if (event.target.closest(".chart-point")) hideChartTooltip();
  });
  document.body.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { hideChartTooltip(); return; }
    var point = event.target.closest(".chart-point");
    if (!point) return;
    var points = Array.from(point.closest("svg.chart").querySelectorAll(".chart-point"));
    var index = points.indexOf(point);
    if (event.key === "ArrowRight") index = Math.min(points.length - 1, index + 1);
    else if (event.key === "ArrowLeft") index = Math.max(0, index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = points.length - 1;
    else return;
    event.preventDefault();
    points[index].focus({ preventScroll: true });
  });
  if (document.querySelector("svg.chart")) {
    window.addEventListener("scroll", hideChartTooltip, true);
    window.addEventListener("resize", hideChartTooltip);
  }

  // Preserve expanded dashboard sections across live refreshes.
  var disclosures = {};
  document.body.addEventListener("htmx:before:swap", function (event) {
    if (!event.target) return;
    if (event.target.id === "main") hideChartTooltip();
    if (event.target.id !== "live-stats") return;
    hideChartTooltip();
    document.querySelectorAll("#live-stats details[data-disclosure]").forEach(function (detail) {
      disclosures[detail.getAttribute("data-disclosure")] = detail.open;
    });
  });
  document.body.addEventListener("htmx:after:swap", function (event) {
    if (event.target && event.target.id === "main") {
      var activeTab = document.querySelector(".site-tabs [aria-current]");
      if (activeTab) activeTab.focus({ preventScroll: true });
    }
    if (!event.target || event.target.id !== "live-stats") return;
    document.querySelectorAll("#live-stats details[data-disclosure]").forEach(function (detail) {
      detail.open = disclosures[detail.getAttribute("data-disclosure")] === true;
    });
  });

  // htmx poll health. The swapped fragment carries a fresh #poll-status
  // each time, so look it up on every event rather than caching it.
  document.body.addEventListener("htmx:after:request", function () {
    setStatus("live", "");
  });
  document.body.addEventListener("htmx:response:error", function (event) {
    setStatus("error", "Update failed (" + event.detail.ctx.response.status + "), retrying.");
  });
  document.body.addEventListener("htmx:error", function () {
    setStatus("error", "Update failed (network), retrying.");
  });
})();
