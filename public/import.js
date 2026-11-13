// Uploads a risulta bundle in 4 MiB parts, then shows the preview and starts the import.
(() => {
  const input = document.getElementById("bundle");
  if (!input) return;
  const status = document.getElementById("status");
  const csrf = document.getElementById("csrf").value;
  const headers = (extra) => Object.assign({ "x-csrf-token": csrf }, extra || {});
  const say = (text) => { status.textContent = text; };
  async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function json(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "request failed (" + response.status + ")");
    return data;
  }
  async function poll(id) {
    for (;;) {
      const state = await json(await fetch("/api/imports/" + id, { headers: headers() }));
      if (state.state === "verified") return state;
      if (state.state === "failed" || state.state === "cancelled") throw new Error(state.error || state.state);
      say("Checking the bundle...");
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const created = await json(await fetch("/api/imports", { method: "POST", headers: headers({ "content-type": "application/json" }), body: "{}" }));
      const size = 1000000;
      for (let n = 0, offset = 0; offset < file.size; n++, offset += size) {
        const text = await file.slice(offset, offset + size).text();
        await json(await fetch("/api/imports/" + created.id + "/parts/" + n, { method: "PUT", headers: headers({ "x-risulta-part-sha256": await sha256(text) }), body: text }));
        say("Uploaded " + Math.min(file.size, offset + size) + " of " + file.size + " bytes");
      }
      await json(await fetch("/api/imports/" + created.id + "/complete", { method: "POST", headers: headers(), body: "{}" }));
      const verified = await poll(created.id);
      const plan = verified.preview;
      say("Ready: " + plan.sites.length + " website(s), " + plan.events.total + " events. Starting...");
      await json(await fetch("/api/imports/" + created.id + "/start", { method: "POST", headers: headers({ "content-type": "application/json" }), body: "{}" }));
      for (;;) {
        const state = await json(await fetch("/api/imports/" + created.id, { headers: headers() }));
        say("Importing: " + state.events.done + " of " + state.events.total + " events");
        if (state.state === "done") { say("Done. Imported " + state.events.done + " events."); return; }
        if (state.state === "failed" || state.state === "cancelled") throw new Error(state.error || state.state);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } catch (error) {
      say("Import failed: " + error.message);
    }
  });
})();
