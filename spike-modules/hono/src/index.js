// Spike: would Hono's router survive sproutboat's bundle validator + Porffor?
// Exercises the same shapes risulta's hand-rolled regex routes use:
// path params, nested routes, method dispatch, redirects, cookies.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";

const app = new Hono();

app.get("/sites/:id", (c) => c.text("site " + c.req.param("id")));
app.get("/sites/:id/settings", (c) => c.text("settings for " + c.req.param("id")));
app.post("/sites/:id/goals", async (c) => {
  const body = await c.req.parseBody();
  return c.json({ id: c.req.param("id"), name: body.name || null });
});
app.get("/login", (c) => {
  const existing = getCookie(c, "session");
  return c.text(existing ? "already in: " + existing : "not logged in");
});
app.post("/login", (c) => {
  setCookie(c, "session", "abc123", { httpOnly: true, sameSite: "Lax" });
  return c.redirect("/", 303);
});
app.notFound((c) => c.text("nope", 404));

export default app;
