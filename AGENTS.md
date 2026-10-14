# sportbonnii — agent instructions

Static GitHub-Pages site: sports clubs in Bonn and every date they publish,
as a filterable table, a month calendar and a club directory. A Node
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
pnpm run registry:fmt     # rewrite registry/*.json canonically, then validate
```

pnpm only (preinstall guard); `pnpm add <pkg>@latest`; the 3-day release
cooldown lives in `pnpm-workspace.yaml`. Sandboxed, pnpm itself fails on its
store index — run installs unsandboxed.

## Map

- `registry/clubs.json`, `registry/sports.json` — the only input;
  `registry/README.md` documents every field and has the fill-in template.
- `pipeline/registry.mjs` — validator + canonical form (zero dependencies:
  the intake bot runs it without install).
- `pipeline/net.mjs` — the only network door: private-address check on every
  redirect hop, robots.txt for crawl requests (a source's own subscription
  feed is fetched like a calendar client — `get(url, { robots: false })`),
  one request per host ≥ 1 s apart, 20 s / 10 MB / 5 redirects.
- `pipeline/adapters/{ical,tec,gancio,jsonld,rss}.mjs` + `index.mjs` —
  `fetchEvents(source, ctx) → { events, warnings, partial? }` with raw events
  (`startMs`/`endMs` UTC or `startDate`/`endDate` for all-day). A v2 portal
  adapter is one file plus one entry in `ADAPTER_TYPES`.
- `pipeline/model.mjs` — raw → events.json entry (Berlin times, caps,
  `exclude`, sports from tagMap → keywords → club, club from aliases, ids).
- `pipeline/merge.mjs` — per-source state rules (ok / partial / error /
  blocked / disabled, 7-day retention, drop-to-zero, all-failed) and
  cross-source dedup (own club source > platform, earlier > later).
- `pipeline/run.mjs` — window (1st of last month … 1st of month +13),
  previous state (local or `$PREVIOUS_STATE_URL`), outputs.
- `pipeline/contract.mjs` — the exact text form of `site/data/*.json` and
  `checkSiteData`; `pipeline/tz.mjs` — Berlin wall clock via Intl;
  `pipeline/detect.mjs` — detection ladder + CLI.
- `site/` — shipped byte for byte: `index.html`, `404.html`, `style.css`,
  `app.js` (wiring), `data.js` (the only `fetch`), `state.js` (hash codec,
  filters, chip counts, the only `history.replaceState`), `dates.js`
  (string-part dates), `table.js`, `calendar.js` (calqrii's `monthGrid`),
  `clubs.js`, `ics.js` (feed writer shared with the pipeline), favicon,
  robots, sitemap. `site/data/` is generated and gitignored.
- `scripts/web-smoke.mjs` — static gate; `PAGE_GRAPH` pins the module set
  (a new import is a one-line change there). `scripts/browser-gate/run.mjs` —
  the browser gate (frozen clock 2026-10-14, browser in America/New_York).
- `.github/scripts/club-intake.mjs` + `.github/workflows/club-intake.yml` +
  `.github/ISSUE_TEMPLATE/verein-hinzufuegen.yml` — issue form → one-file PR.
  Dormant until the GitHub repository variable `INTAKE_ENABLED=true` is set
  (after "Allow GitHub Actions to create and approve pull requests" and the
  labels `verein-vorschlag`, `needs-info`).
- `test/` — `node:test`; captured live payloads under `test/fixtures/<adapter>/`,
  the page snapshot under `test/fixtures/site-data/`, the pinned feed
  `test/fixtures/ics/alle.ics`.

## Invariants

- `site/data/` is never committed. The Pages build fetches and reads the last
  good state back from the live site, so a failing source keeps its dates.
- Output is deterministic: events.json, status.json and the ICS feeds carry
  no timestamps (DTSTAMP = window start); meta.json is the only file with one.
  Two fetches on unchanged sources are byte-identical except meta.json.
- Times in events.json are Europe/Berlin wall clock with offset; all-day
  events are dates with an exclusive end. The page slices strings and never
  does timezone maths — the browser gate runs it in New York to prove it
  (the snapshot's 00:30 night run is the day-mapping probe).
- A TZID without VTIMEZONE, a Windows TZID or a floating time is Berlin wall
  clock, never UTC (ical.js would read it as UTC).
- The page: no external resources, the meta CSP pinned per directive,
  `createElement`/`textContent` only, sport colours via `style.setProperty`,
  no storage. Foreign text is always text.
- Changing the data contract means changing `pipeline/contract.mjs`, the
  snapshot under `test/fixtures/site-data/` and the pinned feed together.
- The issue-form sport options equal the taxonomy labels (test-pinned); a
  label must not contain ", ".
- UI copy is German; code, comments, commits and docs are English.
- No machine-local paths and no private hostnames in any tracked file
  (`test/repo.test.mjs`).
- License GPL-3.0-or-later.
