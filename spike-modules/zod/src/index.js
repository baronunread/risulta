// Spike: same check as valibot, but zod - core/util.js has a real
// `new Proxy(...)` (createTransparentProxy, for lazy schemas). Does its mere
// presence in the bundle fail sproutboat's validator even for a schema this
// simple that never touches lazy/recursive types?
import { z } from "zod";

const GoalSchema = z.object({
  name: z.string().trim().min(1),
  event_name: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  path: z.string().startsWith("/").optional(),
});

export default {
  fetch(request) {
    try {
      const body = request.body || "";
      const params = (() => { const out = {}; new URLSearchParams(body).forEach((v, k) => (out[k] = v)); return out; })();
      const result = GoalSchema.safeParse(params);
      if (!result.success) {
        return new Response(JSON.stringify({ ok: false, error: result.error.issues[0].message }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, goal: result.data }));
    } catch (err) {
      return new Response(JSON.stringify({ threw: true, message: String(err && err.message) }), { status: 500 });
    }
  },
};
