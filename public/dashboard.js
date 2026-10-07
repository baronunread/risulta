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

  // Tracker copy buttons (static install card; never swapped).
  document.querySelectorAll("[data-copy-code]").forEach(function (button) {
    button.addEventListener("click", function () {
      var region = button.parentElement.querySelector(".snippet code");
      var done = function (ok) {
        showToast(ok ? "Copied to clipboard." : "Copy failed.");
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

  // Preserve expanded dashboard sections across live refreshes.
  var disclosures = {};
  document.body.addEventListener("htmx:before:swap", function (event) {
    if (!event.target || event.target.id !== "live-stats") return;
    document.querySelectorAll("#live-stats details[data-disclosure]").forEach(function (detail) {
      disclosures[detail.getAttribute("data-disclosure")] = detail.open;
    });
  });
  document.body.addEventListener("htmx:after:swap", function (event) {
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
