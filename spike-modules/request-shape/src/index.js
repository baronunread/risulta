// Spike: exactly what shape does Porffor's native-fetch Request have?
// Each probe path is isolated so a crash on one doesn't take out the others'
// evidence - restart between probes and diff the log.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const probe = url.searchParams.get("probe");
    try {
      if (probe === "body-prop") {
        return new Response(JSON.stringify({ typeofBody: typeof request.body, value: request.body }));
      }
      if (probe === "text-method") {
        return new Response(JSON.stringify({ hasTextMethod: typeof request.text }));
      }
      if (probe === "text-call") {
        const t = await request.text();
        return new Response(JSON.stringify({ ok: true, text: t }));
      }
      if (probe === "formdata-method") {
        return new Response(JSON.stringify({ hasFormDataMethod: typeof request.formData }));
      }
      if (probe === "formdata-call") {
        const fd = await request.formData();
        return new Response(JSON.stringify({ ok: true, keys: [...fd.keys()] }));
      }
      if (probe === "json-call") {
        const j = await request.json();
        return new Response(JSON.stringify({ ok: true, j }));
      }
      return new Response("no probe matched: " + probe, { status: 400 });
    } catch (err) {
      return new Response(JSON.stringify({ threw: true, message: String(err && err.message) }), { status: 500 });
    }
  },
};
