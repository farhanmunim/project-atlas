# Atlas — Session Handover

Resume point for the Atlas work. Read this first if the session was reset. Branch:
**`claude/project-audit-verification-7vvw9j`** (commit as **Farhan Munim
`<auth@farhan.app>`** — verify `git config user.email` before the first commit).

---

## ✅ Done & pushed (this work stream)

Data-correctness audit + analysis/insight build. All committed to the branch above:

1. **Data-correctness fixes** — corrupt tender bids (103 absurd values) + cost-per-mile
   purged via a leading-token parser + `cleanAward()` re-clean; EV propulsion misclass
   (`E100EV`→electric) fixed; impossible AWT (`AWT≡SWT+EWT`) reconciled; bridge clearance
   made conservative (tighter of metric/imperial); fleet `gas` bucket; `store.js` byte
   count; API `order=` whitelist + serve.js anon-key-only. Each pipeline fix paired with a
   one-time correction of the committed `data/*.json` (the stores are append-only/
   incremental — they don't re-fetch). See `AUDIT-FINDINGS.md` (2026-06-21 section).
2. **Contract dates** — removed the 8 stale hardcoded contract windows (proven wrong vs the
   LBSL programme); the app shows the real scraped commencement as "from <date>". Recovered
   3 real £/mile values from the ingest scrape.
3. **Per-route risk + table enrichment** — `build/accidents.js` pre-aggregates
   `accidents.json.byRoute = {collisions, ksi}` (within ~150 m, from `routes-overview.geojson`);
   rides `/api/v1/accidents`. Table gained **Risk** + **£/mi** columns; CSV mirrors them.
4. **Comparative network rankings + redesigned panel** — `ensureRanks()` ranks every route
   on collisions/KSI/density, EWT/OTP drift, lost mileage, £/mile. The context panel leads
   with a clean **Snapshot** (hero metric + colour-coded "worse than X%" insight rows);
   ranks also inline in the Reliability + Risk blocks. Design inspired by the bus-tools
   "Position Drift" / "Route Lens" screenshots.

Verified live in headless Chromium (Puppeteer) end-to-end — zero uncaught page errors.

---

## ⏳ Pending — BLOCKED on network egress + secrets (do these once unblocked)

The remaining work needs the cloud environment's **Network access** set to **Custom** with
these **Allowed domains** (+ "include defaults"), and the matching **secrets** set:

| Domain | Powers | Secret needed |
|---|---|---|
| `api.tfl.gov.uk`, `tfl.gov.uk`, `content.tfl.gov.uk` | TfL Unified API + tender/LBSL pages/PDFs | `TFL_APP_KEY` (optional, raises limits) |
| `data.bus-data.dft.gov.uk` | BODS SIRI-VM live bus GPS | `BODS_API_KEY` |
| `*.supabase.co` | `/api/v1/history/*` time-series | `SUPABASE_URL`, `SUPABASE_KEY` |

Verify reachability first: `node -e "fetch('https://api.tfl.gov.uk/Line/25/Route').then(r=>console.log(r.status))"`
(a 403 with body "Host not in allowlist" = egress still blocked).

### 1. Live "Position / Schedule Drift" analysis (the bus-tools tool the user wants)
For every bus on a route, compare where the BODS live GPS places it vs TfL's next-stop /
predicted arrival, and predicted vs scheduled.
- **Inputs:** BODS SIRI-VM via `functions/api/live/vehicles.js` (`/api/live/vehicles?line=`)
  → position + line + fix age; TfL Countdown `/Line/{id}/Arrivals` → next stop + predicted
  arrival; TfL Timetable → scheduled arrival.
- **Build:** a live-ops panel — *worst drift on route* (hero, metres), per-vehicle table
  (Vehicle · fix age · next stop · ETA · drift m), aggregates (median/max drift, % fixes
  >60 s stale), a mini drift map. Add it through the `dataSource` seam (no inline fetch),
  and wire a **network ranking** ("route ranks #N for live schedule drift") via `ensureRanks`.
- Reference design: the user's IMG_5042–5045 screenshots (clean hero + label/value rows).

### 2. Tender **tranche** with the tender details (user request #3)
Tranche lives in `tender_programme` (ingest → Supabase) and is served by
`/api/v1/history/tender-programme` (incl. `tranche`); it is NOT on the award pages.
- Add a history seam method (e.g. `fetchTenderProgramme(routeId)`), fetch it for the
  selected route, and show the tranche next to each award / in the Commercial block.
- Needs Supabase reachable to test.

### 3. Accidents **time-series** history endpoint
Add `/api/v1/history/accidents` (Supabase `accidents` table already exists) to both the
prod Function (`functions/api/v1/history/[[path]].js`) and the `serve.js` mirror + the
discovery index, then surface a collisions-over-time trend in the Risk panel. Lets the
"by year" trend use real multi-year data instead of the static snapshot.

### 4. Re-scrape the nulled tender bids
56 award rows had multi-figure cells that smashed into garbage and were nulled. The fixed
`bidMoney()` parser now takes the leading token correctly, so re-running
`node pipeline/run.js --only=tenders` (once `tfl.gov.uk` is reachable) backfills the real
lowest/highest bids. (Genuine joint-bid awards where won < lowest are correct — keep them.)

---

## How to run / verify locally
- Dev server (fixed port 8000): `node pipeline/serve.js 8000` → http://localhost:8000/index.html
- Puppeteer is a devDependency only when installed; the env is expected to provide it
  (`npm i -D puppeteer` if missing — needs npm registry egress). Drive the UI headless to
  verify behaviour; OSM tile `ERR_CERT` console lines are the sandbox blocking tiles, not bugs.
- Inline-script syntax check:
  `node -e "const fs=require('fs'),vm=require('vm');new vm.Script([...fs.readFileSync('index.html','utf8').matchAll(/<script(?![^>]*src)[^>]*>([\\s\\S]*?)<\\/script>/gi)][0][1])"`

## Conventions (don't forget)
- Commit **as Farhan Munim `<auth@farhan.app>`** — no bot author, no AI trailers, no model id.
- Commit/push only when the user says so. Develop on the branch named at the top.
- No build step / framework / bundler. Data behind the `dataSource` seam (no inline fetch in
  components). Every new datapoint: pipeline → `data/*.json` → `/api/v1` → app + docs.
