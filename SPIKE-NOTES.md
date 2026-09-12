# Spike: a component framework, still as a sproutboat binary

Question: could the server-rendered HTML in `src/views.js` (currently hand-built
string concatenation) be replaced with a component framework, while still
shipping as a single native binary via `sproutboat build --standalone`?

## The constraint that actually matters

`sproutboat` bundles the handler (Bun's bundler) and then compiles that bundle
to native code with **Porffor**, an alpha-stage JS-to-native AOT compiler with
a materially smaller JS surface than a browser or Node. Its own bundle
validator (`@sproutboat/runtime/src/source.ts`) hard-rejects a short list of
patterns before it even reaches Porffor:

- `new Proxy(...)` / `Proxy.revocable(...)` — "Porffor compiles it and then
  ignores the handler: a trapped property reads back as `undefined`, with no
  throw." This is the load-bearing constraint for framework choice.
- dynamic `import()`, CommonJS `require()`
- any surviving bare `import` (must resolve statically at bundle time)
- `process` / `Bun` / `Deno` / `Buffer` / `node:*`
- `WebSocket` / `XMLHttpRequest`

**This rules out Vue 3** (its reactivity system is Proxy-based at the core)
and most Proxy-based state/store libraries, before build time is even spent
on them.

## What was tried

[Preact](https://preactjs.com) + `preact-render-to-string`, hyperscript
(`h(...)`) rather than JSX — no build/transform step needed, matching this
project's no-bundler stance. Full source: `spike-preact/src/index.js`.

Tested progressively: a component with props, a `Fragment`, a `.map()` over a
list with `key`s, conditional rendering, `URL`/`searchParams` parsing, and
module-level state (a request counter) surviving across requests within the
running binary — all patterns `views.js` actually uses today.

```
sproutboat check spike-preact      # ✓ passed
sproutboat build spike-preact --target host   # ✓ compiled, 15.9s
./spike-preact/.sproutboat/dist/*/sprout      # ran, served correct HTML
```

Output was byte-correct server-rendered HTML, e.g.:

```html
<!doctype html><html><head><title>Preact spike</title></head><body>
<h1>Preact spike</h1><div class="metric"><span>Requests served</span>
<strong>1</strong></div><ol><li><strong>Signup</strong> → signup</li>
<li><strong>Checkout</strong> → purchase</li></ol></body></html>
```

## Cost

| | binary size | build time |
|---|---|---|
| current `risulta-sprout` (all real routes) | 2.1M | ~24s |
| spike (Preact + one route) | 1.1M | ~16s |

Preact itself is small; the real cost of a migration would be the actual
route/page count, same as today.

## Verdict

**Feasible, not free.** Preact-via-hyperscript survives the whole pipeline —
bundler, validator, Porffor, and the compiled binary runs and renders
correctly. But:

- It's still early/alpha (Porffor), so "it worked for this spike" isn't a
  guarantee every Preact API surface used elsewhere in the ecosystem
  (hooks, `preact/compat`, refs, context) survives the same way — each would
  need the same check-build-run verification before relying on it.
- No hydration story was tested — this project's dashboard uses
  `htmx` for the one bit of interactivity (polling), which is unrelated to
  whether the server-side render is done with string concatenation or
  Preact. Adopting Preact only for SSR gives *organization* (real
  components instead of long string-literal HTML), not new client behavior.
- The current `views.js` approach has zero new dependencies, zero new
  failure modes tied to Porffor's alpha status, and is already working in
  production. Preact would trade some of that stability for readability.

Given `DESIGN.md`'s own stance ("The dashboard is server-rendered. No client
JavaScript is required.") and the Tailwind issue's reasoning (avoid anything
that adds risk to the single-binary story without a concrete pain point), the
honest recommendation is: **don't migrate speculatively.** If `views.js`'s
string-building becomes a real, felt problem (the kind of "I can't find the
closing tag" pain, not a hypothetical one), Preact-via-`h()` is a validated,
working option — this spike is the evidence for that decision when it comes
up, not a reason to act now.

## Branch

This lives on `spike/component-framework`, not `main`. `spike-preact/` is a
fully separate `sproutboat.jsonc` project (its own `check`/`build`), so it
never touches the real app's config or routes. Delete the branch if you don't
want to keep the evidence around; merge just this file to `main` if you want
future-you to have the writeup without the throwaway code.
