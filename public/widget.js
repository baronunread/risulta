(function () {
  var script = document.currentScript;
  var size = script.getAttribute("data-size") || "medium";
  var dimensions = { small: [260, 48], medium: [320, 218], wide: [560, 238] };
  if (!dimensions[size]) size = "medium";
  var preference = script.getAttribute("data-theme") || "auto";
  function themeValue() {
    if (preference === "dark" || preference === "light") return preference;
    return document.documentElement.classList.contains("dark") || document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }
  var theme = themeValue();
  var key = script.getAttribute("data-site");
  if (!key) return;
  var frame = document.createElement("iframe");
  frame.src = new URL("/public/widget/" + encodeURIComponent(key) + "?size=" + size + "&theme=" + theme, script.src).href;
  frame.title = "Public website traffic, powered by Risulta";
  frame.width = dimensions[size][0];
  frame.height = dimensions[size][1];
  frame.style.cssText = "display:block;border:0;max-width:100%;color-scheme:normal";
  frame.loading = "lazy";
  frame.referrerPolicy = "no-referrer";
  script.parentNode.insertBefore(frame, script);
  var inView = true;
  function notify() {
    if (!frame.isConnected) return;
    frame.contentWindow.postMessage({ type: "risulta-widget-theme", dark: themeValue() === "dark" }, new URL(frame.src).origin);
    frame.contentWindow.postMessage({ type: "risulta-widget-visibility", visible: !document.hidden && inView }, new URL(frame.src).origin);
  }
  frame.addEventListener("load", notify);
  new MutationObserver(notify).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  document.addEventListener("visibilitychange", notify);
  if (window.IntersectionObserver) {
    var observer = new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      notify();
    });
    observer.observe(frame);
  }
})();
