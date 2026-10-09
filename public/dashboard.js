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
  function showToast(text, kind, duration) {
    var toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    toast.setAttribute("aria-atomic", "true");
    toast.setAttribute("data-kind", kind || "success");
    var icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = kind === "error" ? "!" : kind === "pending" ? "·" : "✓";
    var message = document.createElement("span");
    message.className = "toast-message";
    message.textContent = text;
    var close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "Dismiss notification");
    close.textContent = "×";
    close.addEventListener("click", function () { clearTimeout(toastTimer); toast.remove(); });
    toast.replaceChildren(icon, message, close);
    clearTimeout(toastTimer);
    if (duration !== 0 && kind !== "error" && kind !== "pending") {
      toastTimer = setTimeout(function () { toast.remove(); }, duration || 5000);
    }
  }

  // Tracker copy buttons are outside the live refresh region.
  document.body.addEventListener("click", function (event) {
      var button = event.target.closest("[data-copy-code]");
      if (!button) return;
      var region = button.parentElement.querySelector(".snippet code");
      var code = button.getAttribute("data-copy-value") || (region && region.textContent);
      var done = function (ok) {
        showToast(ok ? "Copied to clipboard." : "Copy failed.", ok ? "success" : "error");
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
    var text = el.textContent;
    var kind = el.getAttribute("data-toast-kind");
    el.remove();
    showToast(text, kind);
  });

  // Native submission remains available when JavaScript is disabled.
  var backupForm = document.querySelector("[data-backup-form]");
  if (backupForm) {
    var backupFeedback = document.querySelector("[data-backup-feedback]");
    function backupStatus(text, kind) {
      backupFeedback.textContent = text;
      showToast(text, kind || "error", 10000);
    }
    if (backupFeedback.textContent) {
      setTimeout(function () { backupStatus(backupFeedback.textContent, backupFeedback.getAttribute("data-kind") || "success"); }, 100);
    }
    backupForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var button = backupForm.querySelector("button");
      if (button.disabled) return;
      button.disabled = true;
      backupStatus("Creating database backup...", "pending");
      try {
        var response = await fetch(backupForm.action, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf: backupForm.elements.csrf.value }).toString()
        });
        var result = await response.json();
        if (response.ok && result.ok && result.path && result.bytes > 0) {
          backupStatus("Backup created: " + result.path + " (" + result.bytes + " bytes). Copy it off the server for safekeeping.", "success");
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
    chartTooltip.children[1].textContent = point.getAttribute("data-annotation") || point.getAttribute("data-count") + " " + point.getAttribute("data-metric-label").toLowerCase();
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
    var annotation = event.target.closest(".chart-annotation");
    if (annotation) return showChartPoint(chart, annotation, event.clientX, event.clientY, false);
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
    var point = event.target.closest(".chart-point, .chart-annotation");
    if (!point) return;
    var box = point.getBoundingClientRect();
    showChartPoint(point.closest("svg.chart"), point, box.left + box.width / 2, box.top);
  });
  document.body.addEventListener("focusout", function (event) {
    if (event.target.closest(".chart-point, .chart-annotation")) hideChartTooltip();
  });
  document.body.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { hideChartTooltip(); return; }
    var point = event.target.closest(".chart-point, .chart-annotation");
    if (!point) return;
    var points = Array.from(point.closest("svg.chart").querySelectorAll(point.classList.contains("chart-annotation") ? ".chart-annotation" : ".chart-point"));
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
  var metricFocusHref = null;
  document.body.addEventListener("htmx:before:swap", function (event) {
    var swapTarget = event.detail && event.detail.ctx && event.detail.ctx.target || event.target;
    if (!swapTarget) return;
    if (swapTarget.id === "main") {
      hideChartTooltip();
      var metricLink = document.activeElement && document.activeElement.closest(".overview-metric");
      metricFocusHref = metricLink ? metricLink.getAttribute("href") : null;
    }
    if (swapTarget.id !== "live-stats") return;
    hideChartTooltip();
    document.querySelectorAll("#live-stats details[data-disclosure]").forEach(function (detail) {
      disclosures[detail.getAttribute("data-disclosure")] = detail.open;
    });
  });
  document.body.addEventListener("htmx:after:swap", function (event) {
    var swapTarget = event.detail && event.detail.ctx && event.detail.ctx.target || event.target;
    if (swapTarget && swapTarget.id === "main") {
      var activeTab = metricFocusHref
        ? document.querySelector(".overview-metric[aria-current]")
        : document.querySelector(".site-tabs [aria-current]");
      metricFocusHref = null;
      if (activeTab) activeTab.focus({ preventScroll: true });
    }
    if (!swapTarget || swapTarget.id !== "live-stats") return;
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
