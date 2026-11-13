// The risulta bundle: one stream of newline-delimited, ASCII-only JSON lines.
// Every line is an object with a tag `t`. The stream is
//
//   manifest, sites, goals, funnels, annotations, users, events, totals, trailer
//
// in that order. It is plain ASCII on purpose: a part boundary (a 4 MiB wire
// chunk cut by a browser at any byte) can never split a character.
//
// Integrity: every part carries its own sha256 on the wire; every section ends
// with a chained digest (a digest of a digest per group of lines) in the
// trailer, together with the row count of each section. The verifier reads
// the whole stream and checks structure, references, counts and digests
// BEFORE the importer writes a single row. Unknown fields are rejected.
//
// Never in a bundle: password hashes, sessions, CSRF values, read-key hashes,
// link secrets. A bundle that claims `contains_secrets` is refused.
import { asciiJson } from "../util.js";
import { bytesToHex } from "../auth.js";

export const FORMAT = "risulta-bundle";
export const FORMAT_VERSION = 1;
export const PART_BYTES = 4 * 1024 * 1024;
export const SECTIONS = ["sites", "goals", "funnels", "annotations", "users", "events", "totals"];
const TAGS = { site: "sites", goal: "goals", funnel: "funnels", annotation: "annotations", user: "users", event: "events", totals: "totals" };
const GROUP = 256;
const MAX = { sites: 500, goals: 2000, funnels: 500, annotations: 20000, users: 500, steps: 20 };

export class BundleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => { throw new BundleError(code, message); };

// ASCII text to bytes without a TextEncoder (the standalone runtime has none).
export async function sha256(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// --- field validators -------------------------------------------------------
const int = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const text = (max, min = 0) => (v) => String(v) === v && v.length >= min && v.length <= max;
const oneOf = (...values) => (v) => values.indexOf(v) >= 0;
const hex = (max) => (v) => String(v) === v && v.length <= max && /^[0-9a-f]*$/.test(v);
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LINEAGE = /^[a-z0-9._-]{8,64}$/;
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TS = int(0, 4102444800);
const REF = int(1, 9007199254740991);

const SPEC = {
  manifest: {
    format: oneOf(FORMAT), format_version: int(1, 1000), schema_version: int(0, 1000), app_version: text(40),
    created_at: TS, scope: oneOf("site", "org"), lineage: (v) => String(v) === v && LINEAGE.test(v),
    since_id: int(0, 9007199254740991), until_id: int(0, 9007199254740991), contains_secrets: oneOf(false),
  },
  site: {
    ref: REF, name: text(120, 1), domain: (v) => String(v) === v && DOMAIN.test(v), slug: text(60),
    key: (v) => String(v) === v && KEY.test(v), created_at: TS, widget: oneOf(0, 1),
    salts: (v) => Array.isArray(v) && v.length <= 8 && v.every((s) => Object(s) === s && Object.keys(s).length === 2 && text(10, 10)(s.day) && DAY.test(s.day) && hex(128)(s.value) && s.value.length >= 16),
  },
  goal: { site: REF, ref: REF, name: text(80, 1), event_name: (v) => String(v) === v && EVENT_NAME.test(v), path: text(2048), created_at: TS },
  funnel: {
    site: REF, ref: REF, name: text(80, 1), created_at: TS,
    steps: (v) => Array.isArray(v) && v.length >= 1 && v.length <= MAX.steps && v.every((s) => REF(s)),
  },
  annotation: { site: REF, ts: TS, text: text(240, 1) },
  user: {
    email: (v) => String(v) === v && v.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(v), display_name: text(80),
    role: oneOf("admin", "viewer"), sites: (v) => Array.isArray(v) && v.length <= 500 && v.every((s) => text(60, 1)(s)),
  },
  event: {
    id: REF, site: REF, ts: TS, name: (v) => String(v) === v && EVENT_NAME.test(v),
    path: (v) => String(v) === v && v.length <= 2048 && v.charAt(0) === "/", referrer: text(253), visitor: hex(64),
    source: text(128), medium: text(128), campaign: text(128), content: text(128), term: text(128),
    value: (v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1000000000),
  },
  totals: { site: REF, day: (v) => String(v) === v && DAY.test(v), events: int(0, 1e12), pageviews: int(0, 1e12), visitors: int(0, 1e12) },
  trailer: {
    counts: (v) => Object(v) === v,
    sections: (v) => Object(v) === v,
    manifest_sha: (v) => String(v) === v && /^[0-9a-f]{64}$/.test(v),
  },
};

export function checkLine(line) {
  if (Object(line) !== line || Array.isArray(line)) fail("bad_line", "a line must be an object");
  const tag = line.t;
  const spec = SPEC[tag];
  if (!spec) fail("bad_tag", "unknown line tag");
  for (const field of Object.keys(line)) if (field !== "t" && !(field in spec)) fail("unknown_field", "unknown field " + tag + "." + field);
  for (const field of Object.keys(spec)) {
    if (!(field in line) || !spec[field](line[field])) fail("bad_field", "invalid field " + tag + "." + field);
  }
  return line;
}

// --- chained digest ----------------------------------------------------------
class Chain {
  constructor(state) {
    this.h = state ? state.h : "";
    this.pending = state ? state.pending : [];
  }
  async add(line) {
    this.pending.push(line);
    if (this.pending.length >= GROUP) await this.flush();
  }
  async flush() {
    if (!this.pending.length) return;
    this.h = await sha256(this.h + this.pending.join("\n") + "\n");
    this.pending = [];
  }
  async finish() {
    await this.flush();
    return this.h || (await sha256(""));
  }
  state() {
    return { h: this.h, pending: this.pending };
  }
}

// --- writer ------------------------------------------------------------------
// Lines go in, parts come out through onPart({ n, text, bytes, sha256 }). A
// part always ends on a line boundary and is about `partBytes` long.
export class BundleWriter {
  constructor(onPart, partBytes = PART_BYTES, checked = true, partDigest = false) {
    this.checked = checked;
    this.partDigest = partDigest;
    this.onPart = onPart;
    this.partBytes = partBytes;
    this.n = 0;
    this.buf = [];
    this.size = 0;
    this.section = "";
    this.chain = null;
    this.hashes = {};
    this.counts = {};
    this.manifestSha = "";
    this.started = false;
    this.finished = false;
  }
  async emit(textLine) {
    this.buf.push(textLine);
    this.size += textLine.length + 1;
    if (this.size >= this.partBytes) await this.flushPart();
  }
  async flushPart() {
    if (!this.buf.length) return;
    const body = this.buf.join("\n") + "\n";
    this.buf = [];
    this.size = 0;
    const part = { n: this.n++, text: body, bytes: body.length, sha256: this.partDigest ? await sha256(body) : "" };
    await this.onPart(part);
  }
  async closeSection() {
    if (this.chain) this.hashes[this.section] = await this.chain.finish();
    this.chain = null;
  }
  async line(obj) {
    if (this.finished) fail("writer_closed", "the bundle is finished");
    const textLine = asciiJson(obj);
    if (obj.t === "manifest") {
      if (this.started) fail("bad_order", "manifest must be first");
      this.started = true;
      if (this.checked) checkLine(JSON.parse(textLine));
      this.manifestSha = await sha256(textLine);
      await this.emit(textLine);
      return;
    }
    await this.body(obj.t, textLine);
  }
  // A line already serialized by the caller (the hot path: one event, no intermediate object).
  async raw(tag, textLine) {
    if (this.finished) fail("writer_closed", "the bundle is finished");
    await this.body(tag, textLine);
  }
  async body(tag, textLine) {
    if (!this.started) fail("bad_order", "manifest must be first");
    const section = TAGS[tag];
    if (!section) fail("bad_tag", "unknown line tag");
    if (section !== this.section) {
      if (SECTIONS.indexOf(section) < SECTIONS.indexOf(this.section || SECTIONS[0]) && this.section) fail("bad_order", "section out of order");
      await this.closeSection();
      this.section = section;
      this.chain = new Chain();
    }
    this.counts[section] = (this.counts[section] || 0) + 1;
    await this.chain.add(textLine);
    await this.emit(textLine);
  }
  async finish() {
    await this.closeSection();
    const counts = {};
    const sections = {};
    for (const name of SECTIONS) {
      counts[name] = this.counts[name] || 0;
      sections[name] = this.hashes[name] || (await sha256(""));
    }
    await this.emit(asciiJson({ t: "trailer", counts, sections, manifest_sha: this.manifestSha }));
    await this.flushPart();
    this.finished = true;
    return { parts: this.n, counts };
  }
}

// --- verifier ----------------------------------------------------------------
// Fed text chunks of any size (a chunk may end mid-line). Its whole state is
// plain JSON, so a job can stop after any part and resume in a later request.
export class BundleVerifier {
  constructor(options = {}, state = null) {
    this.options = options;
    this.s = state || {
      carry: "", bytes: 0, lines: 0, order: -1, manifest: null, manifestSha: "", counts: {}, chain: null,
      hashes: {}, sites: {}, domains: {}, keys: {}, goals: {}, slugs: {}, evSite: 0, evLast: 0, evDone: [],
      events: { total: 0, trimmed: 0, minTs: 0, maxTs: 0 }, perSite: {}, trailer: null, ended: false,
    };
  }
  get state() {
    return this.s;
  }
  async feed(chunk) {
    const s = this.s;
    if (s.ended) fail("after_trailer", "data after the trailer");
    s.bytes += chunk.length;
    if (this.options.maxBytes && s.bytes > this.options.maxBytes) fail("too_large", "the bundle is larger than the limit");
    const data = s.carry + chunk;
    let start = 0;
    for (;;) {
      const nl = data.indexOf("\n", start);
      if (nl < 0) break;
      await this.line(data.slice(start, nl));
      start = nl + 1;
    }
    s.carry = data.slice(start);
    if (s.carry.length > 70000) fail("line_too_long", "a line is too long");
  }
  async end() {
    const s = this.s;
    if (s.carry) fail("truncated", "the bundle ends inside a line");
    if (!s.ended) fail("truncated", "the bundle has no trailer");
    return this.summary();
  }
  summary() {
    const s = this.s;
    return {
      manifest: s.manifest, counts: s.counts, bytes: s.bytes, events: s.events,
      sites: Object.keys(s.sites).map((ref) => s.sites[ref]), perSite: s.perSite,
    };
  }
  async line(raw) {
    const s = this.s;
    if (s.ended) fail("after_trailer", "data after the trailer");
    if (!raw) fail("empty_line", "empty line");
    let obj;
    try { obj = JSON.parse(raw); } catch { fail("bad_json", "a line is not JSON"); }
    s.lines++;
    checkLine(obj);
    const tag = obj.t;
    if (tag === "manifest") {
      if (s.order !== -1 || s.manifest) fail("bad_order", "manifest must be first and only once");
      this.checkManifest(obj);
      s.manifest = obj;
      s.manifestSha = await sha256(raw);
      s.order = 0;
      return;
    }
    if (!s.manifest) fail("bad_order", "manifest must be first");
    if (tag === "trailer") return this.trailer(obj);
    const section = TAGS[tag];
    const order = SECTIONS.indexOf(section) + 1;
    if (order < s.order) fail("bad_order", "section out of order: " + section);
    if (order !== s.order) {
      await this.closeSection();
      s.order = order;
      s.chain = { section, h: "", pending: [] };
    }
    const chain = new Chain(s.chain);
    await chain.add(raw);
    s.chain = { section, ...chain.state() };
    s.counts[section] = (s.counts[section] || 0) + 1;
    if (MAX[section] && s.counts[section] > MAX[section]) fail("too_many", "too many " + section);
    if (this.options.maxEvents && section === "events" && s.counts.events > this.options.maxEvents) fail("too_many", "too many events");
    this["on_" + tag](obj);
  }
  async closeSection() {
    const s = this.s;
    if (!s.chain) return;
    const chain = new Chain(s.chain);
    s.hashes[s.chain.section] = await chain.finish();
    s.chain = null;
  }
  checkManifest(m) {
    if (m.format_version > FORMAT_VERSION) fail("newer_format", "this bundle needs a newer Risulta");
    if (m.until_id < m.since_id) fail("bad_range", "until_id is below since_id");
  }
  on_site(l) {
    const s = this.s;
    if (s.sites[l.ref]) fail("duplicate", "duplicate site ref");
    if (s.keys[l.key]) fail("duplicate", "duplicate tracker key");
    if (s.domains[l.domain]) fail("duplicate", "duplicate domain");
    s.sites[l.ref] = { ref: l.ref, name: l.name, domain: l.domain, slug: l.slug, key: l.key, created_at: l.created_at, widget: l.widget };
    s.keys[l.key] = 1;
    s.domains[l.domain] = 1;
    if (l.slug) s.slugs[l.slug] = l.ref;
    s.perSite[l.ref] = { events: 0, trimmed: 0, minId: 0, maxId: 0, goals: 0, funnels: 0, annotations: 0 };
  }
  on_goal(l) {
    const s = this.s;
    if (!s.sites[l.site]) fail("dangling", "a goal points at a site that is not in the bundle");
    const k = l.site + ":" + l.ref;
    if (s.goals["ref:" + l.ref] || s.goals[k] || s.goals[l.site + ":n:" + l.name]) fail("duplicate", "duplicate goal");
    s.goals[k] = 1;
    s.goals["ref:" + l.ref] = 1;
    s.goals[l.site + ":n:" + l.name] = 1;
    s.perSite[l.site].goals++;
  }
  on_funnel(l) {
    const s = this.s;
    if (s.goals["fref:" + l.ref]) fail("duplicate", "duplicate funnel");
    s.goals["fref:" + l.ref] = 1;
    if (!s.sites[l.site]) fail("dangling", "a funnel points at a site that is not in the bundle");
    for (const step of l.steps) if (!s.goals[l.site + ":" + step]) fail("dangling", "a funnel step points at a goal that is not in the bundle");
    s.perSite[l.site].funnels++;
  }
  on_annotation(l) {
    if (!this.s.sites[l.site]) fail("dangling", "an annotation points at a site that is not in the bundle");
    this.s.perSite[l.site].annotations++;
  }
  on_user(l) {
    for (const slug of l.sites) if (!this.s.slugs[slug]) fail("dangling", "a user points at a site that is not in the bundle");
  }
  on_event(l) {
    const s = this.s;
    const m = s.manifest;
    if (!s.sites[l.site]) fail("dangling", "an event points at a site that is not in the bundle");
    if (l.id <= m.since_id || l.id > m.until_id) fail("out_of_range", "an event id is outside the manifest range");
    if (l.site !== s.evSite) {
      if (s.evDone.indexOf(l.site) >= 0) fail("bad_order", "events of one site must be together");
      if (s.evSite) s.evDone.push(s.evSite);
      s.evSite = l.site;
      s.evLast = 0;
    }
    if (l.id <= s.evLast) fail("bad_order", "event ids must ascend within a site");
    s.evLast = l.id;
    const ev = s.events;
    const per = s.perSite[l.site];
    ev.total++;
    per.events++;
    if (!per.minId) per.minId = l.id;
    per.maxId = l.id;
    if (!ev.minTs || l.ts < ev.minTs) ev.minTs = l.ts;
    if (l.ts > ev.maxTs) ev.maxTs = l.ts;
    if (this.options.cutoff && l.ts < this.options.cutoff) { ev.trimmed++; per.trimmed++; }
  }
  on_totals(l) {
    if (!this.s.sites[l.site]) fail("dangling", "a totals row points at a site that is not in the bundle");
  }
  async trailer(t) {
    const s = this.s;
    await this.closeSection();
    for (const name of SECTIONS) {
      const expected = t.counts[name];
      if (!Number.isInteger(expected) || expected !== (s.counts[name] || 0)) fail("count_mismatch", "row count mismatch in " + name);
      const empty = await sha256("");
      const got = s.hashes[name] || empty;
      if (t.sections[name] !== got) fail("checksum_mismatch", "checksum mismatch in " + name);
    }
    for (const name of Object.keys(t.counts)) if (SECTIONS.indexOf(name) < 0) fail("unknown_field", "unknown section in trailer");
    for (const name of Object.keys(t.sections)) if (SECTIONS.indexOf(name) < 0) fail("unknown_field", "unknown section in trailer");
    if (t.manifest_sha !== s.manifestSha) fail("checksum_mismatch", "manifest checksum mismatch");
    s.trailer = t;
    s.ended = true;
  }
}

// Verify a whole bundle held as text parts. Used by tests and the browser
// upload path; jobs feed the same verifier part by part.
export async function verifyParts(parts, options = {}) {
  const verifier = new BundleVerifier(options);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.sha256 && part.sha256 !== (await sha256(part.text))) fail("part_checksum", "part " + i + " fails its checksum");
    await verifier.feed(part.text);
  }
  return verifier.end();
}

// Parse the lines of one part (after verification), calling visit(object).
export function* partLines(textPart) {
  let start = 0;
  for (;;) {
    const nl = textPart.indexOf("\n", start);
    if (nl < 0) break;
    if (nl > start) yield JSON.parse(textPart.slice(start, nl));
    start = nl + 1;
  }
}
