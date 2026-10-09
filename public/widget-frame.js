(function () {
  var timer;
  var pending;
  var visible = true;
  var revoked = false;
  var key = location.pathname.split("/").pop();
  var status = document.querySelector("[data-status]");
  function format(value) { return Number(value).toLocaleString("en-US"); }
  function curve(days) {
    var max = Math.max.apply(null, [1].concat(days));
    var values = days.map(function (n) { return 72 - n / max * 56; });
    var slopes = values.slice(1).map(function (n, i) { return (n - values[i]) / 80; });
    var tangents = values.map(function (_, i) {
      if (!i) return slopes[0];
      if (i === values.length - 1) return slopes[i - 1];
      var left = slopes[i - 1], right = slopes[i];
      return left * right <= 0 ? 0 : 2 * left * right / (left + right);
    });
    var path = "M0 " + values[0];
    for (var i = 1; i < values.length; i++) {
      path += " C" + ((i - 1) * 80 + 80 / 3) + " " + (values[i - 1] + tangents[i - 1] * 80 / 3) + " " + (i * 80 - 80 / 3) + " " + (values[i] - tangents[i] * 80 / 3) + " " + (i * 80) + " " + values[i];
    }
    return path;
  }
  function paused() { return document.hidden || !visible || revoked; }
  function schedule() {
    clearTimeout(timer);
    if (!paused()) timer = setTimeout(refresh, 60000);
  }
  async function refresh() {
    if (paused() || pending) return;
    pending = new AbortController();
    var timeout = setTimeout(function () { if (pending) pending.abort(); }, 15000);
    try {
      var response = await fetch("/public/data/" + encodeURIComponent(key), { signal: pending.signal, credentials: "omit", cache: "no-store" });
      if (response.status === 404) {
        revoked = true;
        document.querySelector(".card").textContent = "Public sharing is unavailable.";
        return;
      }
      if (!response.ok) throw new Error("Unable to refresh");
      var data = await response.json();
      if (!Array.isArray(data.days) || data.days.length !== 7 || !data.days.every(function (n) { return Number.isFinite(n) && n >= 0; })) throw new Error("Invalid data");
      ["current", "visitors", "pageviews"].forEach(function (field) {
        var node = document.querySelector("[data-" + field + "]");
        if (node) node.textContent = format(data[field]);
      });
      var line = document.querySelector(".line");
      if (line) {
        var path = curve(data.days);
        line.setAttribute("d", path);
        document.querySelector(".area").setAttribute("d", path + " L480 84 L0 84Z");
      }
      document.querySelector(".domain").textContent = data.domain;
      if (status) status.textContent = "Last 7 days · UTC";
      document.querySelector(".dot").classList.remove("stale");
    } catch {
      if (!paused()) {
        if (status) status.textContent = "Update delayed";
        document.querySelector(".dot").classList.add("stale");
      }
    } finally {
      clearTimeout(timeout);
      pending = null;
      schedule();
    }
  }
  function visibilityChanged() {
    clearTimeout(timer);
    if (paused()) { if (pending) pending.abort(); }
    else refresh();
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "risulta-widget-theme") {
      document.documentElement.classList.toggle("theme-dark", event.data.dark === true);
      return;
    }
    if (event.data.type !== "risulta-widget-visibility") return;
    var next = event.data.visible === true;
    if (visible !== next) { visible = next; visibilityChanged(); }
  });
  schedule();
})();
