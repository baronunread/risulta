// Spike: the `cookie` package (parse/serialize) in place of risulta's
// hand-rolled readCookies/setSessionCookie in src/auth.js.
import { parseCookie, stringifySetCookie } from "cookie";

export default {
  fetch(request) {
    const cookies = parseCookie(request.headers.get("cookie") || "");
    const setHeader = stringifySetCookie({
      name: "risulta_session",
      value: "abc123",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 604800,
    });
    return new Response(JSON.stringify({ parsed: cookies, wroteHeader: setHeader }), {
      headers: { "content-type": "application/json", "set-cookie": setHeader },
    });
  },
};
