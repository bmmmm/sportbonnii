# sportbonnii — agent instructions

Static GitHub-Pages site: sports clubs in Bonn and every date they publish,
as a filterable table, a month calendar and a club directory. A Node
pipeline (one runtime dependency, `ical.js`) turns the club registry into
`site/data/*.json` + ICS feeds; the page is vanilla ESM with no build step.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test                 # node --test "test/**/*.test.mjs" (fixtures only)
pnpm run test:live        # RUN_LIVE=1: every enabled source, real network (run unsandboxed)
pnpm run fetch            # pipeline/run.mjs → site/data/
pnpm run smoke            # scripts/web-smoke.mjs (site/data/ if present, else test/fixtures/site-data/)
pnpm run serve            # python3 scripts/serve.py 8765 site
pnpm run gate:browser     # headless Chrome over CDP, fixture data (local, not CI)
pnpm run detect <url>     # prints a registry source snippet
pnpm run registry:fmt     # rewrite registry/*.json in canonical form
```

pnpm only (preinstall guard); `pnpm add <pkg>@latest`; the 3-day release
cooldown lives in `pnpm-workspace.yaml`.

## Invariants

- `site/` is shipped byte for byte; `site/data/` is generated and gitignored.
  Data is never committed — the Pages build fetches, and reads the last good
  state back from the live site (`PREVIOUS_STATE_URL`).
- Output is deterministic: `events.json`, `status.json` and the ICS feeds
  carry no timestamps; `meta.json` is the only file with one.
- Times in `events.json` are Europe/Berlin wall clock with offset
  (`2026-10-26T08:00:00+01:00`); all-day events are dates with an exclusive
  end. The page slices strings and never does timezone maths.
- The page: no external resources, strict meta CSP, `createElement` /
  `textContent` only, `fetch` only in `site/data.js`, the address bar written
  only by `site/state.js` (`history.replaceState`), no storage.
- UI copy is German; code, comments, commits and docs are English.
- No machine-local paths and no private hostnames in any tracked file
  (`test/repo.test.mjs`).
- License GPL-3.0-or-later.
