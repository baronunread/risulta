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

  // Tracker copy buttons (static install card; never swapped).
  document.querySelectorAll("[data-copy-code]").forEach(function (button) {
    button.addEventListener("click", function () {
      var region = button.parentElement.querySelector(".snippet code");
      var note = document.getElementById("copy-status");
      var done = function (ok) {
        if (note) note.textContent = ok ? "Copied." : "Copy failed.";
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

  // htmx poll health. The swapped fragment carries a fresh #poll-status
  // each time, so look it up on every event rather than caching it.
  document.body.addEventListener("htmx:afterRequest", function () {
    setStatus("live", "Live.");
  });
  document.body.addEventListener("htmx:responseError", function (event) {
    setStatus("error", "Update failed (" + event.detail.xhr.status + "), retrying.");
  });
  document.body.addEventListener("htmx:sendError", function () {
    setStatus("error", "Update failed (network), retrying.");
  });
})();
