# sportbonnii — agent instructions

Static GitHub-Pages site: sports clubs in Bonn and every date they publish,
as a filterable table, a month calendar, a map and a club directory. A Node
pipeline (one runtime dependency, `ical.js`) turns the club registry into
`site/data/*.json` + ICS feeds; the page is vanilla ESM with no build step.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test                 # node --test "test/**/*.test.mjs" (fixtures only; live.test skips itself)
pnpm run test:live        # RUN_LIVE=1: every enabled source, real network — run unsandboxed
pnpm run fetch            # pipeline/run.mjs → site/data/ (+ Markdown summary on stdout) — unsandboxed
pnpm run smoke            # scripts/web-smoke.mjs (site/data/ if present, else test/fixtures/site-data/)
pnpm run serve            # python3 scripts/serve.py 8765 site → http://127.0.0.1:8765/
pnpm run gate:browser     # headless Chrome over CDP on the fixture snapshot — local, unsandboxed
pnpm run detect <url>     # prints a registry source entry for any club URL — unsandboxed
pnpm run registry:fmt     # rewrite registry/**/*.json canonically, validate, regenerate docs/vereine.md
```

pnpm only (preinstall guard); `pnpm add <pkg>@latest`; the 3-day release
cooldown lives in `pnpm-workspace.yaml`. Sandboxed, pnpm itself fails on its
store index — run installs unsandboxed.

## Map

- `registry/clubs/<id>.json` (one club each, optional `venues` ≤ 3 with
  OSM ref/coordinates and `use`), `registry/platforms/<id>.json`,
  `registry/sports.json` — the only input; a source may carry a fallback
  `kind`. `registry/README.md` documents every field and has the fill-in
  template.
- `pipeline/registry.mjs` — `readRegistry`, validator, canonical form,
  department guard (`nameKey`, `sameSite`, `departmentConflict`), `--fmt`
  (zero dependencies: the intake bot runs it without install).
- `pipeline/overview.mjs` → `docs/vereine.md` — the generated club overview
  (one row per club: departments, district, venues, calendars, website);
  a test pins it to the registry.
- `pipeline/net.mjs` — the only network door: private-address check on every
  redirect hop, robots.txt for crawl requests (a source's own subscription
  feed is fetched like a calendar client — `get(url, { robots: false })`),
  one request per host ≥ 1 s apart, 20 s / 10 MB / 5 redirects. Every answer
  carries `etag`/`lastModified`; `get(url, { ifNoneMatch, ifModifiedSince })`
  is conditional and resolves to `{ notModified: true }` on 304.
- `pipeline/adapters/{ical,tec,gancio,jsonld,rss}.mjs` + `index.mjs` —
  `fetchEvents(source, ctx) → { events, warnings, partial? }` with raw events
  (`startMs`/`endMs` UTC or `startDate`/`endDate` for all-day), plus
  `CONDITIONAL` (true only when one request stands for the source). A v2
  portal adapter is one file plus one entry in `ADAPTER_TYPES`.
- `pipeline/model.mjs` — raw → events.json entry (Berlin times, caps,
  `exclude` (substring, or `=` for a whole title/tag), sports from tagMap →
  keywords → club, club from aliases, ids, `kind` from
  `eventKind`: title/tag rules, training > celebration veto > spiel, else the
  source's `kind`, else veranstaltung; `status` cancelled also from the title
  („fällt aus", „entfällt", „abgesagt" — not negated, not a replay); `home` from `homeGame` for games only:
  the title's own marker („auswärts", Away, Gast bei, Heim, Heimspiel,
  Heimturnier, Home), then the place — a club venue (`venueIndex`) or a Bonn
  postcode is home, another postcode away, else the word Bonn home —, then a
  title „… in <Ort>" (a Bonn Ortsteil in that phrase is home — one another
  town shares, like Gronau or Südstadt, only when the club's venue or
  district names it —, another capitalised place away), else null).
- `pipeline/merge.mjs` — per-source state rules (ok / unchanged on 304 /
  partial / error / blocked / disabled, 7-day retention, drop-to-zero,
  all-failed), `changed` = the last run with a new or modified event (a
  removal alone does not count), validators kept for ok answers, and
  cross-source dedup (own club source > platform, earlier > later).
- `pipeline/run.mjs` — window (1st of last month … 1st of month +13),
  previous state (local or `$PREVIOUS_STATE_URL`, with meta.json's `build`),
  conditional requests, outputs. The first request of a source carries the
  previous validators only when `$BUILD_ID` (pages.yml: `github.sha`) equals
  the previous build and the window is unchanged; a 304 keeps the source's
  previous events. Locally `BUILD_ID` is unset, so every run fetches in full.
  A previous state from another build (or none known) is classified again
  (`refreshEvent`: kind when the title decides it, home, a title's
  cancellation), so the events a failing source keeps follow today's rules.
- `pipeline/contract.mjs` — the exact text form of `site/data/*.json` and
  `checkSiteData`; `pipeline/tz.mjs` — Berlin wall clock via Intl;
  `pipeline/detect.mjs` — detection ladder + CLI.
- `site/` — shipped byte for byte: `index.html`, `404.html`, `style.css`,
  `app.js` (wiring), `data.js` (the only `fetch`), `state.js` (hash codec,
  filters, chip counts, the only `history.replaceState`), `dates.js`
  (string-part dates), `table.js`, `calendar.js` (calqrii's `monthGrid`),
  `clubs.js`, `ics.js` (feed writer shared with the pipeline), `kinds.js`
  (event kinds and venue uses, shared with the pipeline), `venue.js`
  (OpenStreetMap link, `venueIndex` shared with the pipeline), `map.js`
  (the Karte view: a slippy map of its own on OSM tiles, venue markers,
  `eventVenue`/`mapPlaces`), favicon,
  robots, sitemap. `site/data/` is generated and gitignored.
- `scripts/web-smoke.mjs` — static gate; `PAGE_GRAPH` pins the module set
  (a new import is a one-line change there). `scripts/browser-gate/run.mjs` —
  the browser gate (frozen clock 2026-10-14, browser in America/New_York).
- `.github/scripts/club-intake.mjs` + `.github/workflows/club-intake.yml` +
  `.github/ISSUE_TEMPLATE/verein-hinzufuegen.yml` — issue form → PR with the
  club file and the regenerated overview (path allowlist in `publishableFiles`).
  Live on GitHub (`INTAKE_ENABLED=true`, Actions may create PRs, labels
  `verein-vorschlag` / `needs-info`). A bot PR's tests/Security runs wait for
  approval (GitHub's guard for Actions-made PRs) — merge locally like
  dependabot-adopt: fetch the PR head from `github`, merge, `pnpm test`,
  push both remotes.
- `test/` — `node:test`; captured live payloads under `test/fixtures/<adapter>/`,
  the page snapshot under `test/fixtures/site-data/`, the pinned feed
  `test/fixtures/ics/alle.ics`.

## Invariants

- `site/data/` is never committed. The Pages build fetches and reads the last
  good state back from the live site, so a failing source keeps its dates.
- Output is deterministic: events.json, status.json and the ICS feeds carry
  no run timestamp (DTSTAMP = window start); meta.json is the only file with
  one. Two fetches on unchanged sources are byte-identical except meta.json.
  status.json's `changed`, `etag` and `lastModified` describe the source, not
  the run: `lastModified` is the server's validator echoed verbatim, and all
  three move only when the source does.
- Only sources with news are re-read: a 304 is honoured only against a state
  the same build produced for the same window, only for single-request
  adapters (`CONDITIONAL = true`: ical, gancio, jsonld — a 304 on TEC page 1
  or an RSS feed would hide changes behind it), and only when events.json
  holds the source's whole delivery (a dedup loser is read in full). A push
  (new commit) refetches everything; so does a manual run with `full`.
  Measured 2026-10-14: of the four live sources only bonn.jetzt sends an
  ETag, and it answers 304 only with fetch's cache mode `no-cache` (net.mjs);
  the content comparison behind `changed` needs no server support.
  Known limits: a server with volatile validators makes status.json move
  with it, and `changed` also moves when our own normalisation changes
  (kind, home and a title's cancellation excepted: `refreshEvent` applies
  today's rules to both sides; a kind the tags or the source's `kind` made
  and the title contradicts is overruled there until the source answers).
  A previous state without `kind` is upgraded from the titles alone
  (`upgradeLegacyEvent` in run.mjs), so `changed` moves once for a source
  whose kind needs its tags or the source's `kind`; one without `home` gets
  it from `homeGame` with the club's venues (the same rule as a fresh run).
- Times in events.json are Europe/Berlin wall clock with offset; all-day
  events are dates with an exclusive end. The page slices strings and never
  does timezone maths — the browser gate runs it in New York to prove it
  (the snapshot's 00:30 night run is the day-mapping probe).
- A TZID without VTIMEZONE, a Windows TZID or a floating time is Berlin wall
  clock, never UTC (ical.js would read it as UTC).
- The page opens on games without the recognised away games (`art=spiel`,
  `ort=heim`; a game whose side is unknown counts as home); `art=alle`
  lifts the kind filter. Home/away only ever touches games. Links from before
  2026-10-15 without `art` now open on home games too (accepted).
- The page: no external resources except OpenStreetMap tiles in the Karte
  view (`img-src` admits `https://tile.openstreetmap.org` only; no tile before
  the tab opens; no `referrer` meta — the tile policy needs the Referer; the
  browser gate answers tiles locally), the meta CSP pinned per directive,
  `createElement`/`textContent` only, sport colours via `style.setProperty`,
  no storage. Foreign text is always text.
- Changing the data contract means changing `pipeline/contract.mjs`, the
  snapshot under `test/fixtures/site-data/` and the pinned feed together.
- The issue-form sport options equal the taxonomy labels (test-pinned); a
  label must not contain ", ".
- A department lives inside its club: a sport in the club's `sports` (a
  department calendar is a source with `sports`), never an entry of its own.
  The validator refuses equal names/aliases, a name that starts with another
  club's name, and the same website (subdomains included); the intake bot
  answers such a suggestion with needs-info. A merge conflict in
  `docs/vereine.md`: take either side, then `pnpm run registry:fmt`.
- UI copy is German (the generated `docs/vereine.md` counts as UI copy);
  code, comments, commits and other docs are English.
- No machine-local paths and no private hostnames in any tracked file
  (`test/repo.test.mjs`).
- License GPL-3.0-or-later.
