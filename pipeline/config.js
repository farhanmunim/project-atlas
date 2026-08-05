/**
 * config.js — the dataset registry.
 *
 * Each entry declares: a name, the builder that produces it, a TTL (how long a
 * result stays "fresh" before the orchestrator will re-run it — caching layer 2),
 * and whether a failure is soft (keep last-good, continue) or hard (abort).
 *
 * Adding a new data source to the suite = add a build/<name>.js and one row
 * here. That's the whole extension surface — modular by construction.
 *
 * Order matters: reference data (routes/geometry) before things that may depend
 * on it. Builders run top-to-bottom.
 */

import { build as buildDiversions } from "./build/diversions.js";
import { build as buildRoutes } from "./build/routes.js";
import { build as buildRouteMeta } from "./build/route-meta.js";
import { build as buildTenders } from "./build/tenders.js";
import { build as buildGarages } from "./build/garages.js";
import { build as buildFleet } from "./build/fleet.js";
import { build as buildVehicles } from "./build/vehicles.js";
import { build as buildStatus } from "./build/status.js";
import { build as buildPerformance } from "./build/performance.js";
import { build as buildAccidents } from "./build/accidents.js";
import { build as buildBridges } from "./build/bridges.js";
import { build as buildCrowding } from "./build/crowding.js";
import { build as buildLocalities } from "./build/localities.js";
import { build as buildDbMirror } from "./build/db-mirror.js";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const DATASETS = [
  {
    name: "diversions",
    build: buildDiversions,
    ttlMs: 0,              // live snapshot — always re-pull; also feeds the routes builder's
                           // baseline freeze (must run BEFORE routes)
    soft: true,
    cadence: "live · TfL status + Route/Sequence diff vs baseline",
  },
  {
    name: "routes",
    build: buildRoutes,
    ttlMs: 1 * DAY,        // network revisions land within a day; conditional requests keep the daily pull cheap
    soft: true,
    cadence: "daily",
  },
  {
    name: "route-meta",
    build: buildRouteMeta,
    ttlMs: 1 * DAY,        // PVR/operator/garage changes land next-day (details.htm updates daily)
    soft: true,
    cadence: "daily · londonbusroutes.net (garages.csv + details.htm)",
  },
  {
    name: "garages",
    build: buildGarages,
    ttlMs: 1 * DAY,        // estate changes are rare but cheap to check daily (one CSV + cached geocodes)
    soft: true,
    cadence: "daily · londonbusroutes.net + postcodes.io",
  },
  {
    name: "fleet",
    build: buildFleet,
    ttlMs: 1 * DAY,        // fleet composition moves slowly; the reg sample is live (CDC accrues coverage)
    soft: true,
    cadence: "daily · TfL Line Arrivals (+ DVLA VES when keyed)",
  },
  {
    name: "vehicles",
    build: buildVehicles,
    ttlMs: 1 * DAY,        // inverts fleet (free, no API) → reg→routes roster; Relay scaffold
    soft: true,
    cadence: "daily · derived from fleet (no API calls)",
  },
  {
    name: "tenders",
    build: buildTenders,
    ttlMs: 1 * DAY,        // awards are immutable + incremental — a daily check only fetches NEW tender ids
    soft: true,
    cadence: "event-driven · TfL tender results (incremental)",
  },
  {
    name: "performance",
    build: buildPerformance,
    ttlMs: 1 * DAY,        // Last-Modified skip makes a daily check ~free; new QSI period lands next-day
    soft: true,
    cadence: "~4-weekly · TfL QSI + MPS PDFs",
  },
  {
    name: "accidents",
    build: buildAccidents,
    ttlMs: 30 * DAY,       // STATS19 is annual — a monthly TTL re-checks without hammering DfT
    soft: true,
    cadence: "annual · DfT STATS19",
  },
  {
    name: "bridges",
    build: buildBridges,
    ttlMs: 30 * DAY,       // EPOWR is refreshed annually — a monthly TTL re-checks without hammering the Datastore
    soft: true,
    cadence: "annual · London Datastore EPOWR (TfL height restrictions)",
  },
  {
    name: "localities",
    build: buildLocalities,
    ttlMs: 30 * DAY,       // OSM place names barely change — monthly re-check is plenty
    soft: true,
    cadence: "monthly · OSM Overpass (place=town|suburb)",
  },
  {
    name: "status",
    build: buildStatus,
    ttlMs: 0,              // live snapshot — always re-pull when the pipeline runs
    soft: true,
    cadence: "≈5 min (TfL caches 30s)",
  },
  {
    name: "crowding",
    build: buildCrowding,
    ttlMs: 30 * DAY,       // BUSTO is annual — a monthly TTL re-checks without re-pulling 98MB needlessly
    soft: true,
    cadence: "annual · TfL BUSTO (crowding.data.tfl.gov.uk)",
  },
  {
    name: "db-mirror",
    build: buildDbMirror,
    ttlMs: 0,              // always mirror the current store into the warehouse (CDC dedups)
    soft: true,
    cadence: "every run · SQLite warehouse",
  },
];
