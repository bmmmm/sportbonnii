# sportbonnii

**Live: <https://bmmmm.github.io/sportbonnii/>**

One page for sports in Bonn: which sports exist, which clubs offer them, and
every date those clubs publish — matches, training, camps, club events — in a
filterable table, a month calendar, a map of the clubs' venues and a club
directory. Sports are the primary filter; every view narrows as you pick
them. The page opens on matches and competitions at home.

The site is static. A scheduled build reads each club's own published
calendar (iCalendar, WordPress *The Events Calendar*, Gancio, schema.org
JSON-LD, RSS), normalises everything into one `events.json` and publishes
the result to GitHub Pages. There is no server and no database, and the page
loads nothing from third parties — except the OpenStreetMap tiles of the map
view, once it is opened.

## Use

- **Filter** by sport (chips), kind of date, home or away games, club, free
  text and time range. The filter lives in the address
  (`#ansicht=karte&sport=rugby&ort=alle&zeit=monat`), so a view can be
  shared as a link.
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
pnpm run gate:browser   # headless Chrome on the fixture snapshot (local)
```

`site/data/` is generated and never committed. Without it, `smoke` checks the
snapshot in `test/fixtures/site-data/`; the browser gate always runs on that
snapshot, with a frozen clock and the browser set to New York time.

### Add a club

Add a file `registry/clubs/<id>.json` (field reference and a fill-in template:
[`registry/README.md`](registry/README.md)), run `pnpm run registry:fmt` and
`pnpm test`.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Third-party notices and the origin
of ported code: [NOTICE](NOTICE).
