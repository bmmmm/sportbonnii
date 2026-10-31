# Calendar coverage and maintenance

Last checked: 2026-10-28. A homepage RSS feed is not a calendar: enable it
only after verifying that its item pages deliver dated events. All requests
use `pipeline/net.mjs`. A URL in the registry is fetched like a browser
loads it; robots.txt applies to discovery only (AGENTS.md, `net.mjs`).

## Newly connected sources

- **SSF Bonn, Floorball:** official Floorball Deutschland subscriptions for
  [1. FBL Herren](https://saisonmanager.de/fd/2447-1-fbl-herren),
  [1. FBL Damen](https://saisonmanager.de/fd/2448-1-fbl-damen) and
  [2. FBL Herren Nord/West](https://saisonmanager.de/fd/2449-2-fbl-herren-nordwest).
  The published league ICS feeds contain all clubs; `include` selects only
  SSF Dragons Bonn, including the second team. League ids need review each
  season (`reviewAfter` in the registry).
- **SSF Bonn, club calendar:** the `amphicms` adapter reads the endpoint
  [the calendar page](https://www.ssfbonn.de/de/termine/) loads (volleyball
  and youth table-tennis home games, tournaments, club dates). Floorball and
  the table-tennis 1. Herren are excluded there: the federation feeds above
  name the opponent.
- **DAV Bonn:** [the published activity overview](https://dav-bonn.de/termine/)
  provides dates for Kleine Bergschule and via ferrata activities. The `dav`
  adapter selects those activity groups and links to each original event.
  Single dates without a published overview time are marked “Uhrzeit noch
  offen”. Multi-session climbing courses are deliberately omitted: a range
  such as 5–19 November is not evidence of a daily course. Importing those
  requires a parser for the individual session dates on the detail pages.

## Clubs without a verified calendar delivery

| Club | Finding | Next useful step |
| --- | --- | --- |
| [Beueler Judo-Club](https://beueler-judo-club.de/neues-termine/) | Published annual overviews are from 2023/2024; no subscription found | Look for a current federation or club feed |
| [Bonn Fire](https://bonnfire.de/) | Custom WordPress match pages, no linked supported feed | Check the official league calendar or add a fixture-tested page adapter |
| [Bonn Gamecocks](https://gamecocks.de/teams/gamedays/) | Gameday page and news RSS; no verified event feed | Look for a current AFV schedule export; do not import news publication dates |
| [Bonn Rugby Union Club](https://www.rugby-bonn.de/start) | Match announcements on the homepage, no supported calendar found | Check the rugby federation's subscription export |
| [Bonnsai](https://www.bonnsai.org/) | RSS discovered; event delivery not verified | Verify a federation schedule or structured event pages |
| [Blau-Weiss Bonn Kanu](https://bwb-kanu.de/) | JEvents lists future events; no linked subscription found | Find a valid public export or add a JEvents adapter |
| [Der Fechtverein](https://der-fechtverein.de/) | RSS discovered; event delivery not verified | Check the federation calendar and club-specific filtering |
| [Golden Star Cricket Club Bonn](https://gsccbonn.de/en/) | RSS discovered; event delivery not verified | Check the current league's fixture export |
| [Olympischer Fechtclub Bonn](https://ofc-bonn.de/) | Homepage returned HTTP 500 | Retry after the website recovers, then inspect its calendar |
| [PSV Bonn](https://www.psvbonn.de/wp/) | RSS discovered; event delivery not verified | Inspect department and federation calendars |
| [Segel-Club Bonn](https://www.segel-club-bonn.de/informationen/termine/) | Handwritten date list currently ends in September 2026 | Wait for current dates, then verify a feed or add a table adapter |

## Season checks

FuPa season slugs, DBB league ids, myTischtennis team ids and the Floorball
league ids carry `reviewAfter`. Review the selected teams and competitions,
verify the replacement feed with `pnpm run test:live`, then update that date
alongside the URL. End-of-schedule and empty-delivery warnings are advisory;
off-season calendars can legitimately have no future games. `expectEmpty`
suppresses those warnings only when that emptiness is intentional.

Warnings live in `meta.json`, not in `status.json`: advancing the clock
must not change an otherwise unchanged source's validators or content date.
They are recalculated after every run, including conditional HTTP 304 runs.

## Unknown times

HSG's subscription uses exactly 00:00 with a synthetic 90-minute duration
for unconfirmed games, including placeholder opponents. Only this verified
source opts into `midnightTimeUnknown`; its placeholder pairings are
excluded separately. Other sources' midnight and 00:30 events stay timed.

The event contract appends optional `timeUnknown: true` to a single-day,
date-only entry. The UI distinguishes it from a full-day event. Its ICS
entry has date values, a visible explanatory note, `STATUS:TENTATIVE` and
`TRANSP:TRANSPARENT` (cancelled events retain `STATUS:CANCELLED`). The id
stays the same when the source later confirms a time.
