// Input-shape validation for the forms/JSON bodies in index.js. Each schema's
// custom messages are the exact redirect-query error codes views.js already
// renders (e.g. "goal-name-required"). The same code string is reused by
// unrelated flows on different pages (site creation's and the profile
// form's "name-required" land on different query params, "error" vs
// "profile"), so callers keep their own small code -> JSON-message map
// rather than share one here - "name-required" needs to read "name is
// required" for site creation but "display name is required" for the
// profile form. Format rules reuse domain.js's real validators rather than
// re-deriving a regex; business rules that need the database (domain
// uniqueness, funnel goal ids belonging to the site) stay in index.js - a
// static schema can't see the database.
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

// Runs `schema` against `input`; on failure returns the first issue's code
// (a key into MESSAGES) instead of a valibot object, so callers don't need
// to know anything about valibot's result shape.
export function validate(schema, input) {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true, value: result.output };
  return { ok: false, code: result.issues[0].message };
}
