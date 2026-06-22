/**
 * build/tenders.js — full bus tender award history, grouped by route.
 *
 * Discovery lists ~2,500 award events; we fetch each result page once and CACHE
 * it (incremental: a re-run only pulls btIDs we haven't seen — award events are
 * immutable once published). Output:
 *   tenders.json = { byId: { [btID]: award }, byRoute: { [routeNum]: [award…] } }
 * byRoute is denormalised + sorted newest-first so Atlas/Mandate read it directly.
 *
 * --limit=N caps NEW fetches per run (dev); production fills the rest over runs.
 */

import { fetchTenderIndex, fetchTenderResult } from "../sources/tfl-tenders.js";
import { mapLimit } from "../lib/http.js";
import { check } from "../lib/validate.js";
import { canonicalOperator } from "../lib/normalize.js";
import { deriveAward } from "../lib/tender-parse.js";

function parseDate(s) { if (!s) return 0; const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; }
function routeKeys(routeText) {
  // "1/N1" → ["1","N1"]; "24" → ["24"]
  return routeText.split(/[\/,]/).map((s) => s.trim()).filter(Boolean);
}

export async function build(ctx) {
  const { sink, log, args } = ctx;

  const prev = (await sink.readDataset("tenders")) || { byId: {} };
  const byId = { ...(prev.byId || {}) };
  // award events are immutable / append-only: the total can only grow. A shrink
  // means we'd overwrite a good store with a corrupt/partial one — refuse it.
  const previousCount = prev.count ?? Object.keys(prev.byId || {}).length;

  const index = await fetchTenderIndex();
  let todo = index.filter((x) => !byId[x.btID]);
  if (args.limit) todo = todo.slice(0, Number(args.limit));
  log.info(`tenders: ${index.length} awards in index · ${Object.keys(byId).length} cached · ${todo.length} to fetch`);

  let ok = 0, fail = 0, done = 0;
  await mapLimit(todo, 8, async (item) => {
    try {
      const rec = await fetchTenderResult(item.btID);
      if (rec) { byId[item.btID] = { ...rec, route: rec.route || item.route }; ok++; }
      else fail++;
    } catch (e) { fail++; }
    if (++done % 200 === 0 || done === todo.length) log.info(`  fetched ${done}/${todo.length} (ok ${ok}, fail ${fail})`);
  });

  // regroup everything by route, newest-first
  const byRoute = {};
  for (const id of Object.keys(byId)) {
    const a = byId[id];
    // Clone into byRoute with a canonical operator brand (raw kept on `operatorRaw`),
    // so the read layer shows clean, consistent names and "operator changed" compares
    // parent brands — without mutating the append-only raw `byId` cache. deriveAward
    // attaches the structured joint-bid / awarded-vehicle / tranche fields (in lockstep
    // with the Supabase derivations) so the app + table + export read them directly.
    const award = deriveAward({ ...a, operator: canonicalOperator(a.operator) || a.operator, operatorRaw: a.operator });
    for (const k of routeKeys(a.route || "")) (byRoute[k] ||= []).push(award);
  }
  for (const k of Object.keys(byRoute)) byRoute[k].sort((x, y) => parseDate(y.awardDate) - parseDate(x.awardDate) || Number(y.btID) - Number(x.btID));

  check(Object.keys(byId).length >= previousCount,
    `tenders: count shrank ${previousCount} → ${Object.keys(byId).length} (awards are append-only) — refusing to overwrite last-good`);
  await sink.writeDataset("tenders", { generatedAt: new Date().toISOString(), source: "TfL tender results (13923/13796.aspx)", count: Object.keys(byId).length, byId, byRoute });
  log.info(`tenders: ${Object.keys(byId).length} awards total · ${Object.keys(byRoute).length} route keys`);
  return { source: "TfL tender award results (13923/13796.aspx)", rows: Object.keys(byId).length, files: ["data/tenders.json"], note: todo.length ? `+${ok} new` : "all cached" };
}
