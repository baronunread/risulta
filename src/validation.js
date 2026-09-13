// Each schema's custom messages are the redirect-query error codes views.js
// already renders (e.g. "goal-name-required"). The same code is reused by
// unrelated flows with different JSON messages ("name-required" means "name
// is required" for site creation but "display name is required" for
// profile), so callers keep their own code -> message map rather than share
// one here. Business rules needing the database (domain uniqueness, funnel
// goal ids) stay in index.js - a static schema can't see the database.
import * as v from "valibot";
import { validDomain, validEventName } from "./domain.js";

export const SiteSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "name-required"), v.maxLength(80)),
  domain: v.pipe(v.string(), v.check(validDomain, "domain-invalid")),
});

export const GoalSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, "goal-name-required"), v.maxLength(80)),
  eventName: v.pipe(v.string(), v.check(validEventName, "goal-event-invalid")),
  path: v.union([v.literal(""), v.pipe(v.string(), v.startsWith("/", "goal-path-invalid"))]),
});

export const ProfileSchema = v.object({
  displayName: v.pipe(v.string(), v.trim(), v.minLength(1, "name-required"), v.maxLength(80)),
  email: v.pipe(v.string(), v.check((value) => value.includes("@"), "email-invalid")),
});

export function validate(schema, input) {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, code: result.issues[0].message };
}
