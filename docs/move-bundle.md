# The Risulta bundle

A bundle is one stream of newline-delimited JSON, ASCII only (non-ASCII text is written as `\uXXXX`),
so it can be cut at any byte, uploaded in parts and rejoined without damage. It is what "Download
data", "Move to risulta.dev", "Move back" and the browser import all use.

```
manifest   first line, once
site       one per website: name, domain, slug, tracker key, widget flag, recent daily salts
goal       per site
funnel     per site, steps are goal refs
annotation per site
user       invitation list (email, display name, role, site slugs); on by default, `?users=0` leaves it out
event      id, site, ts, name, path, referrer, visitor, source, medium, campaign, content, term, value
totals     per site and day: events, pageviews, visitors (a content check)
trailer    last line: row counts, a chained digest per section, the manifest digest
```

Sections appear in that order. Events of one site are together and ascend by id.

## Rules

- `format` is `risulta-bundle`. An importer refuses a `format_version` newer than it knows.
- Unknown fields are rejected, not ignored. So are unknown tags, duplicates, references to something that
  is not in the file, event ids outside `since_id`..`until_id`, and a claimed `contains_secrets`.
- The whole stream is verified (structure, references, counts, digests) before the first row is written.
- A bundle never holds password hashes, sessions, CSRF values, read-API-key hashes or link secrets.
  People travel as an invitation list the owner confirms. Read keys are created again by hand.
- Ids in the file are references only. The importer issues its own ids and keeps the mapping, so
  importing the same bundle again changes nothing.
- A tracker key is kept only when no website anywhere uses it. A key is never taken over by an import.

## Moving

A move is the whole instance: every website, with its goals, funnels, notes and events, and the people.
`lineage` ties the pieces of one move together: a bulk copy of event ids up to N, then the catch-up of ids
in (N, X], where X is the highest id any website's fence covers once all of them are sealed. Both are
ordinary bundles of the same lineage, windows of the one id sequence across all websites. No timestamps
are used for the boundary. Inside a bundle the events of one website stay together.

`Download data` streams the same bundle, for everything the org has, from `/api/exports/download`
(`?site=ID` narrows it, for scripts; the pages offer no choice).
