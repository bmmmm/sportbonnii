# Registry

The pipeline's only input. `clubs.json` lists the clubs (and city-wide
platforms such as bonn.jetzt) with their published calendars;
`sports.json` is the sport taxonomy the page filters by.

Both files are kept in **canonical form** — keys sorted at every level,
two-space indent, clubs and platforms sorted by `id`. After editing, run:

```sh
pnpm run registry:fmt   # rewrite canonically
pnpm test               # validator, taxonomy and form checks
```

## Adding a club — template

Copy this block into `"clubs"` (position does not matter, `registry:fmt`
sorts it), fill it in, delete the optional lines you do not need:

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

## Club fields

| field | required | meaning |
| --- | --- | --- |
| `id` | yes | lowercase slug (`a-z`, `0-9`, single hyphens), unique across clubs and platforms; part of every event's source key and of the feed name `verein-<id>.ics` |
| `name` | yes | display name |
| `sports` | yes | one or more ids from `sports.json` |
| `district` | no | Stadtbezirk: `Bonn`, `Bad Godesberg`, `Beuel` or `Hardtberg` |
| `website` | yes | http(s) URL of the club's site |
| `aliases` | no | names under which the club appears on platforms; a platform event whose title or place contains one is assigned to the club |
| `active` | no | `false` hides the club from the directory (default `true`) |
| `sources` | yes | the club's calendars, richest first (on a duplicate date the earlier source wins) |

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
| `exclude` | no | case-insensitive texts; an event whose title or tags contain one is dropped |
| `params` | no | free-form settings, reserved for league/portal adapters |
| `expectEmpty` | no | `true` when the source legitimately has no upcoming dates (the live test then accepts zero events) |

## Platforms

`"platforms"` holds city-wide sources that are not a club (bonn.jetzt).
Fields: `id`, `name`, `website`, `sources`. Their events are assigned to a
club through the clubs' `aliases`; sports come from the source's `tagMap`,
then from the sport `keywords` in the title, then from the matched club,
else `sonstiges`.

## Sports

`sports.json` entries: `id` (slug), `label` (German), `emoji`, `colour`
(`#rrggbb` with a relative luminance between 0.118 and 0.30, so the colour
bar keeps a 3:1 contrast on light and dark backgrounds), optional `keywords`
(lowercase word starts that assign a platform event to the sport, e.g.
`"schwimm"` matches *Schwimmfest*). The order is the order of the filter
chips. `sonstiges` is the catch-all and must stay.
