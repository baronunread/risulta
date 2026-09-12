# Spike: which npm packages could simplify the actual code?

Not a component framework this time (see `SPIKE-NOTES.md`) — this targets the
three most repetitive, hand-rolled parts of `src/index.js`/`src/auth.js`:
11 hand-written route regexes, hand-rolled cookie parsing/serialization, and
~9 manual `if (!x) return redirect(...error=...)` validation chains. Each
candidate lives in its own `spike-modules/<name>/` sproutboat project —
isolated `check`/`build`/`run`, nothing touches the real app.

## Headline finding, before any specific package: the Request shim

`request.body` in this runtime is **already a plain string**, not the
standard `ReadableStream` — confirmed directly:

```
GET ?probe=body-prop  -> {"typeofBody":"string","value":"a=1&b=2"}
GET ?probe=text-call  -> {"ok":true,"text":"a=1&b=2"}          (works)
GET ?probe=formdata-method -> {"hasFormDataMethod":"undefined"} (doesn't exist)
```

Calling the missing `.formData()` directly throws a *catchable but useless*
error (empty message). That's annoying but survivable. What's not survivable:
**Hono's router works perfectly (params, nested routes, cookies), but its
`c.req.parseBody()` helper crashes the entire native process with zero
diagnostics** — no thrown error, no log line, the process just dies. Any
future dependency that assumes a spec-compliant `Request` (streaming body,
multipart, `Blob`/`File`) is a landmine of exactly this shape: not a clean
incompatibility, a silent total crash. This is the most important thing this
spike found — worth remembering for anything reaching into request bodies,
independent of which specific package.

## URLSearchParams is only partially iterable

Also found by accident, also broadly relevant: `new URLSearchParams(body)`
has `.get()` and `.forEach()` implemented, but **no `.entries()`, no
`Symbol.iterator`** — `for...of`, spread, and `Object.fromEntries(usp)` all
throw ("Tried for..of on non-iterable type"). This is exactly why the real
app's 10 existing `new URLSearchParams(body)` call sites all work today: they
only ever call `.get(name)`. The moment code tries to iterate all fields
generically (which any validation-library integration needs, to build a
plain object from form data), it must use `.forEach()`, not
`Object.fromEntries()` or `for...of`. Cheap workaround, easy to not know
about until it silently doesn't work.

## Results by package

| Package | `check` | Porffor build | Runs correctly | Verdict |
|---|---|---|---|---|
| `hono` (router only) | ✓ | ✓ | ✓ params/nested routes/cookies | **usable** — but never call `c.req.parseBody()`/`.formData()` (see above) |
| `hono` (`parseBody()`) | ✓ | ✓ | ✗ **crashes the process** | don't use |
| `cookie` (parse/serialize) | ✓ | ✓ | ✓ full round-trip | **usable** |
| `valibot` (object/pipe/regex/union) | ✓ | ✓ | ✓ all cases correct | **usable** |
| `zod` v4 (equivalent schema) | ✓ | ✓ | ✗ **crashes the process** on first real `safeParse()` | don't use |

Zod's `new Proxy(...)` (in `core/util.js`, for lazy/recursive schemas) got
tree-shaken out of the bundle for this simple schema, so `sproutboat check`
passed — but it still crashes at runtime for an unrelated reason (an
uncaught `TypeError: Cannot read property of undefined`, below the level a
JS `try/catch` in the handler can even see). Valibot, doing the same
validation, works cleanly. Zod is out regardless of the Proxy question.

## What this unblocks

- **A real router.** Hono's routing (path params, method dispatch, 404
  handling) replaces the 11 hand-written `/^\/sites\/(\d+)\/settings$/`-style
  regexes with `app.get("/sites/:id/settings", handler)` — genuinely less
  code, genuinely more readable — as long as body parsing stays manual
  (`new URLSearchParams(request.body)`, using `.forEach()` if iterating).
- **Real cookie handling.** `cookie`'s `parseCookie`/`stringifySetCookie`
  replace the hand-rolled string building in `auth.js` outright, including
  options (`httpOnly`, `sameSite`, `maxAge`, `secure`) that are currently
  string-concatenated by hand.
- **Schema validation.** `valibot` replaces the `if (!name) return
  redirect(...+"error=goal-name-required")` chains with one schema per form
  and a single `safeParse`, with the same error-code strings threaded through
  as custom messages — no behavior change, less repetition.

## What's still off the table

Same two constraints as the component-framework spike, restated because they
keep being the actual gate: **`new Proxy()`** (silently broken traps) and
**anything assuming a real streaming `Request`/`Response` body** (silent
crash, not a clean failure). Any future candidate should be checked against
both before it's trusted, the same way this batch was — `check` passing is
not sufficient evidence, only an actual Porffor build + a running request
against every code path that matters is.

## Verdict

Narrower and more concrete than the framework spike: **Hono (router only) +
`cookie` + `valibot` is a real, validated way to cut down `index.js`'s
repetition**, not just a hypothetical. Unlike the framework question, this
one has an actual felt problem behind it (11 duplicated regexes, hand-rolled
cookie strings, repetitive validation chains) — so the "don't migrate
speculatively" reasoning from the other spike doesn't apply the same way
here. Still your call whether the payoff (less repetition) is worth three
new dependencies against an alpha compiler with a demonstrated silent-crash
failure mode; if it goes ahead, do it as one focused PR per package
(matching this branch's isolation), not all three at once.

## Branch

`spike/npm-simplify`, off `main`. `spike-modules/{hono,cookie,valibot,zod}/`
are throwaway sproutboat projects for the evidence above; delete the branch
or cherry-pick the actual `src/`/`auth.js` migration if you want to act on
this.
