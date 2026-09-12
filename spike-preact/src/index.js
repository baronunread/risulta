// Spike: can a Preact-rendered page compile through sproutboat's
// Porffor pipeline? See ../../SPIKE-NOTES.md for the write-up.
import { h, Fragment } from "preact";
import render from "preact-render-to-string";

function Metric({ label, value }) {
  return h("div", { class: "metric" }, h("span", null, label), h("strong", null, value));
}

function GoalList({ goals }) {
  if (!goals.length) return h("p", { class: "hint" }, "No goals yet.");
  return h(
    "ol",
    null,
    goals.map((g) => h("li", { key: g.id }, h("strong", null, g.name), " → ", g.event)),
  );
}

function Page({ title, count, goals }) {
  return h(
    Fragment,
    null,
    h("head", null, h("title", null, title)),
    h(
      "body",
      null,
      h("h1", null, title),
      h(Metric, { label: "Requests served", value: String(count) }),
      h(GoalList, { goals }),
    ),
  );
}

let requests = 0;
const sampleGoals = [
  { id: 1, name: "Signup", event: "signup" },
  { id: 2, name: "Checkout", event: "purchase" },
];

export default {
  fetch(request) {
    requests += 1;
    const url = new URL(request.url);
    const goals = url.searchParams.get("empty") ? [] : sampleGoals;
    const html = "<!doctype html><html>" + render(h(Page, { title: "Preact spike", count: requests, goals })) + "</html>";
    return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
  },
};
