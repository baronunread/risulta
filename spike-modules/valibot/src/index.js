import * as v from "valibot";

const GoalSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "goal-name-required"), v.maxLength(80)),
  event_name: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+$/, "goal-event-invalid")),
  path: v.optional(v.union([v.literal(""), v.pipe(v.string(), v.startsWith("/", "goal-path-invalid"))])),
});

function formToObject(usp) {
  const out = {};
  usp.forEach((value, key) => (out[key] = value));
  return out;
}

export default {
  fetch(request) {
    try {
      const body = request.body || "";
      const params = formToObject(new URLSearchParams(body));
      const result = v.safeParse(GoalSchema, params);
      if (!result.success) {
        return new Response(JSON.stringify({ ok: false, error: result.issues[0].message }), { status: 400 });
      }
      return new Response(JSON.stringify({ ok: true, goal: result.output }));
    } catch (err) {
      return new Response(JSON.stringify({ threw: true, message: String(err && err.message) }), { status: 500 });
    }
  },
};
