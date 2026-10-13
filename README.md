# sportbonnii

One page for sports in Bonn: which sports exist, which clubs offer them, and
every date those clubs publish — matches, training, camps, club events — in a
filterable table, a month calendar and a club directory. Sports are the
primary filter; every view narrows as you pick them.

The site is static. A scheduled build reads each club's own published
calendar (iCalendar, WordPress *The Events Calendar*, Gancio, schema.org
JSON-LD, RSS), normalises everything into one `events.json` and publishes
the result to GitHub Pages. There is no server and no database, and the page
loads nothing from third parties.

## Use

- **Filter** by sport (chips), club, free text and time range. The filter
  lives in the address (`#ansicht=kalender&sport=rugby&zeit=monat`), so a
  view can be shared as a link.
- **Subscribe** to all dates, one sport or one club as an `.ics` feed, or
  download the current filter as a file.
- **Suggest a club** through the issue form *Verein hinzufügen*; a workflow
  checks the calendar link and opens a pull request with the registry entry.

## Develop

Node ≥ 22 and pnpm (the version is pinned in `package.json`; corepack picks
it up). One runtime dependency: [`ical.js`](https://github.com/kewisch/ical.js).

```sh
pnpm install
pnpm test               # unit tests on captured fixtures
pnpm run fetch          # fetch every enabled source into site/data/
pnpm run smoke          # static gate over site/ (CSP, no external resources, …)
pnpm run serve          # http://127.0.0.1:8765/
pnpm run detect <url>   # find the richest calendar endpoint behind a URL
```

`site/data/` is generated and never committed. Without it, `smoke` and the
browser gate use the snapshot in `test/fixtures/site-data/`.

### Add a club

Add an entry to `registry/clubs.json` (field reference and a fill-in template:
[`registry/README.md`](registry/README.md)), run `pnpm run registry:fmt` and
`pnpm test`.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Third-party notices and the origin
of ported code: [NOTICE](NOTICE).
