# Registry

The pipeline's only input:

- `clubs/<id>.json` — one file per club with its published calendars,
  named after the club's `id` (`clubs/rc-bonn-rhein-sieg.json`);
- `platforms/<id>.json` — city-wide sources that are not a club
  (bonn.jetzt), one file each in the same way;
- `sports.json` — the sport taxonomy the page filters by.

Every file is kept in **canonical form** — keys sorted at every level,
two-space indent, trailing newline, a club or platform file named
`<id>.json`. The order of clubs everywhere is the order of their ids, never
of the file names. After editing, run:

```sh
pnpm run registry:fmt   # rewrite every file canonically (never renames one)
pnpm test               # validator, taxonomy and form checks
```

## Adding a club — template

Save this as `clubs/<id>.json` — here `clubs/tv-musterstadt.json` — fill
it in and delete the optional lines you do not need (`registry:fmt` sorts
the keys):

```json
{
  "id": "tv-musterstadt",
  "name": "TV Musterstadt",
  "sports": ["handball", "turnen"],
  "district": "Beuel",
  "website": "https://www.tv-musterstadt.de/",
  "aliases": ["TV Musterstadt", "TVM"],
  "active": true,
  "sources": [
    { "id": "termine", "type": "ical", "url": "https://www.tv-musterstadt.de/termine.ics" }
  ]
}
```

Not sure which `type` and `url` a club's calendar has? `pnpm run detect
<any page of the club>` probes the site and prints a ready source entry. A
club without an online calendar gets `"sources": []` — it still appears in
the directory.

## One club, one entry — departments live inside their club

A department of a multi-sport club ("SSF Bonn Tischtennis") is never an
entry of its own: it is a sport in the club's `sports`, its calendar a
source of the club with `sports` narrowed to it, its name (or a team name
such as "SSF Dragons Bonn") an alias of the club. There is never "SSF Bonn",
"SSF Bonn Tischtennis" and "SSF Bonn Schwimmen" as three clubs.

The validator (in `pnpm test`, which CI runs on every push and pull
request, and before every `pnpm run fetch`) refuses, for every pair of
clubs and platforms:

- the same name — any name or alias, compared without case, accents, a
  trailing "e.V." or punctuation (hyphens count: "Rugby Bonn-Rhein-Sieg"
  is no department of "Rugby Bonn");
- a name that is another entry's name plus more words ("SSF Bonn
  Tischtennis" next to "SSF Bonn");
- the same website, a subdomain of it (`lacrosse.ssfbonn.de` is
  `ssfbonn.de`), or a path below it — two clubs on a shared host with
  different paths (`sites.google.com/view/a`, `…/view/b`) are fine.

The intake bot applies the same check (`departmentConflict` in
`pipeline/registry.mjs`) and asks for more information instead of opening
a PR; the form's "Abteilung von" field turns a department of a club not yet
listed into an entry for that club.

Before adding a club:

1. Look for it under every name it goes by: the generated overview
   [`docs/vereine.md`](../docs/vereine.md) (one row per club;
   `pnpm run registry:fmt` rewrites it), `ls registry/clubs/` and
   `rg -i '<part of the name>' registry/`.
2. Is it a department? Check the imprint, statutes or "Abteilung" on its
   site; if so, find the main club and add the sport (and the calendar, as
   a source with `sports`) there — or add the main club.
3. Compare the website host with the listed clubs' websites.

## Club fields

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | lowercase slug (`a-z`, `0-9`, single hyphens), unique across clubs and platforms, equal to the file name; part of every event's source key and of the feed name `verein-<id>.ics` |
| `name` | yes | display name |
| `sports` | yes | one or more ids from `sports.json` |
| `district` | no | Stadtbezirk: `Bonn`, `Bad Godesberg`, `Beuel` or `Hardtberg` |
| `website` | yes | http(s) URL of the club's site |
| `aliases` | no | names under which the club appears on platforms, departments and teams included; a platform event whose title or place contains one is assigned to the club. Unique across clubs and platforms (see above) |
| `active` | no | `false` hides the club from the directory (default `true`) |
| `sources` | yes | the club's calendars, richest first (on a duplicate date the earlier source wins) |
| `venues` | no | 1 to 3 places where the club plays or trains, the main one first (fields below) |

## Venue fields

| field | required | meaning |
| --- | --- | --- |
| `name` | yes | display name ("Sportpark Pennenfeld") |
| `address` | no | street, postcode and town |
| `lat`, `lon` | yes | coordinates as numbers, `lat` 50.6–50.8 and `lon` 7.0–7.3 (around Bonn — catches swapped or mistyped numbers) |
| `osm` | no | the OpenStreetMap object of the facility itself: `node/<n>`, `way/<n>` or `relation/<n>`; the OpenStreetMap link (`osmUrl` in `site/venue.js`) opens it, else a marker at `lat`/`lon` |
| `use` | no | `spiel` (matches, competitions) or `training`; leave it out when the place serves both |

## Source fields

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | slug, unique within the club |
| `type` | yes | `ical` (iCalendar / webcal), `tec` (WordPress *The Events Calendar* REST API), `gancio` (Gancio `/api/events`), `jsonld` (a page with schema.org `Event` JSON-LD), `rss` (a feed whose item pages carry JSON-LD) |
| `url` | yes | https URL of the feed or endpoint |
| `enabled` | no | `false` lists the source without fetching it (default `true`) |
| `note` | no | why the source looks the way it does; never shipped to the page |
| `sports` | no | narrows the source to some of the club's sports (a department calendar) |
| `tagMap` | no | `{ "<upstream tag>": "<sport id>" }` — assigns sports from the source's own categories |
| `exclude` | no | case-insensitive texts; an event whose title or tags contain one is dropped — or, written `=Text`, whose whole title or one whole tag is that text (`=Ferien` drops the category „Ferien", not „Ferienprogramm") |
| `params` | no | free-form settings, reserved for league/portal adapters |
| `expectEmpty` | no | `true` when the source legitimately has no upcoming dates (the live test then accepts zero events) |
| `kind` | no | `spiel`, `training` or `veranstaltung` — the kind for the source's dates whose title and tags name none (a calendar that only carries trainings, say) |

## Platforms

`platforms/<id>.json` holds a city-wide source that is not a club
(bonn.jetzt). Fields: `id`, `name`, `website`, `sources`. Their events are
assigned to a club through the clubs' `aliases`; sports come from the
source's `tagMap`, then from the sport `keywords` in the title, then from
the matched club, else `sonstiges`.

## Sports

`sports.json` entries: `id` (slug), `label` (German), `emoji`, `colour`
(`#rrggbb` with a relative luminance between 0.118 and 0.30, so the colour
bar keeps a 3:1 contrast on light and dark backgrounds), optional `keywords`
(lowercase word starts that assign a platform event to the sport, e.g.
`"schwimm"` matches *Schwimmfest*). The order is the order of the filter
chips. `sonstiges` is the catch-all and must stay.
