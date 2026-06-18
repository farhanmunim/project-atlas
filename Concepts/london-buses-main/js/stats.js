/**
 * stats.js — Right-panel Overview (hero + operator cards) + operator drawer.
 *
 * Exports:
 *   setGarageData(garages, garageRoutes)   Hand the garage records from ui.js
 *                                          so per-operator garage lists + the
 *                                          drawer can resolve real data.
 *   renderOperatorStats(visibleRoutes)     Rebuild hero numbers + operator
 *                                          cards from the visible route set.
 *   openOperatorDrawer(operatorName, agg)  Populate + slide in the drawer.
 *
 * Hero stats (all derived from the *currently-filtered* visible routes):
 *   • Routes across London   — total route count (mirrors sidebar)
 *   • PVR                    — total peak vehicle requirement summed across routes
 *   • EV share of PVR        — electric-propulsion PVR ÷ total PVR, as a %
 *
 * Unknown dims (on-time, YoY deltas, contract data) render as literal "XXX".
 */

import {
  state,
  opDrawer, drawerBack, drawerName, drawerSub, drawerSwatch,
  dGarages, dContracts,
} from './state.js';
import { opColor, highlightGarageByCode } from './map.js';

// Populate a drawer KPI slot. Slots 1-4 are always visible; the optional
// slot 5 (capacity) carries a `data-dkpi-slot` wrapper that we hide when
// `value` is null so it only appears for entities with capacity on file.
function setKpi(slot, value, label) {
  const v = document.querySelector(`[data-dkpi="v${slot}"]`);
  const l = document.querySelector(`[data-dkpi="l${slot}"]`);
  if (v) v.textContent = value ?? '—';
  if (l) l.textContent = label ?? '';
  const wrap = document.querySelector(`[data-dkpi-slot="${slot}"]`);
  if (wrap) wrap.hidden = (value == null);
}

// Set the capacity KPI (slot 5), or hide it when no figure is on file.
function setCapacityKpi(capacity) {
  const valid = Number.isFinite(capacity) && capacity > 0;
  setKpi(5, valid ? capacity.toLocaleString() : null, 'Capacity');
}

// Network totals (computed once per renderOperatorStats pass from the
// visible-route set so drawer percentages always reflect the active filter).
let _networkTotalRoutes = 0;
let _networkTotalPvr    = 0;

// Expose the currently-focused garage code so the pill renderer can ignore
// drawer re-openings that don't originate from the "View routes" CTA.
let _activeGarageCode = null;

// OPERATOR_COLORS / fallback / opColor now live in map.js (single source of
// truth — see import above). Local copies removed so palettes can never
// diverge. The previous local table here was missing 'Arriva London' and
// 'Uno Buses', causing those operators to silently fall back to grey on
// stats panels while displaying correct colours on the map.

// Short, customer-facing operator names. Data values may arrive as either
// the short form (Go-Ahead) or the longer marketing form (Go-Ahead London);
// both map to the same short label.
const DISPLAY_NAME = {
  'Arriva':            'Arriva',
  'Arriva London':     'Arriva',
  'Go-Ahead':          'Go-Ahead',
  'Go-Ahead London':   'Go-Ahead',
  'First':             'First',
  'First London':      'First',
  'Stagecoach':        'Stagecoach',
  'Stagecoach London': 'Stagecoach',
  'Metroline':         'Metroline',
  'Transport UK':      'Transport UK',
  'RATP':              'RATP',
  'RATP Dev':          'RATP',
  'Uno':               'Uno',
  'Uno Buses':         'Uno',
};

// Garage data — set once at boot by ui.js.
let _garages      = [];
let _garageRoutes = {};

export function setGarageData(garages, garageRoutes) {
  _garages      = garages ?? [];
  _garageRoutes = garageRoutes ?? {};
}

function garagesFor(operator) {
  return _garages.filter(g => g.operator === operator);
}

function countGaragesForOperators(operators) {
  if (!_garages.length) return 0;
  const set = new Set(operators.filter(o => o && o !== 'Unknown'));
  return _garages.filter(g => set.has(g.operator)).length;
}

// ── Overview render ──────────────────────────────────────────────────────────

/**
 * Render the Overview tab from the current visible-route set.
 *
 * Builds three things:
 *   1. The three KPI tiles at the top (Routes / Garages / Operators).
 *   2. A per-operator table: Routes %, PVR %, EV %. Rows are clickable and
 *      open the operator drawer.
 *   3. EV adoption bar chart beneath the table — one horizontal bar per
 *      operator, sorted by EV share (operators with zero EV exposure are
 *      still shown but tail the list).
 */
export function renderOperatorStats(visibleRoutes) {
  const total = visibleRoutes.length;

  const ops = {};
  let totalPvr = 0;
  for (const r of visibleRoutes) {
    const op  = r.operator ?? 'Unknown';
    const pvr = Number.isFinite(r.pvr) ? r.pvr : 0;
    (ops[op] ??= { routes: 0, pvr: 0, ev: 0, evPvr: 0, ageSum: 0, agePvr: 0 }).routes++;
    ops[op].pvr += pvr;
    totalPvr    += pvr;
    if (r.propulsion === 'electric') {
      ops[op].ev++;
      ops[op].evPvr += pvr;
    }
    // PVR-weighted avg fleet age: a 50-bus route on 8y old buses contributes
    // 10× a 5-bus route on 1y old buses to the operator's headline figure.
    // Only routes that have BOTH age and pvr contribute — a route with age
    // but no pvr would need to be unit-weighted, which would skew the average
    // toward the smallest routes and mix with the dominant PVR-weighted logic.
    if (Number.isFinite(r.vehicleAgeYears) && pvr > 0) {
      ops[op].ageSum += r.vehicleAgeYears * pvr;
      ops[op].agePvr += pvr;
    }
  }

  const sorted = Object.entries(ops).sort(([aK, aV], [bK, bV]) => {
    if (aK === 'Unknown') return 1;
    if (bK === 'Unknown') return -1;
    return bV.routes - aV.routes;
  });
  const nonUnknownCount = sorted.filter(([k]) => k !== 'Unknown').length;

  // KPI tiles (2×2): Routes · Operators · Garages · PVR
  setText('hero-routes',   total.toLocaleString());
  setText('hero-ops',      String(nonUnknownCount));
  setText('hero-garages',  countGaragesForOperators(Object.keys(ops)).toLocaleString());
  setText('hero-pvr',      totalPvr ? totalPvr.toLocaleString() : '—');
  // Mobile peek mirrors the operator count (Routes + Garages are handled by
  // filters.js on every filter change; the op count only changes when the
  // visible-route set does, which is here).
  setText('mob-ops',       String(nonUnknownCount));

  // Snapshot network totals so the drawer % KPIs stay in sync with filters.
  _networkTotalRoutes = total;
  _networkTotalPvr    = totalPvr;

  renderOpTable(sorted, total, totalPvr);
  renderFleetMix(visibleRoutes, totalPvr);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderOpTable(sorted, totalRoutes, totalPvr) {
  const body = document.getElementById('ov-ops-body');
  if (!body) return;
  body.innerHTML = '';
  const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : '—';

  for (const [op, v] of sorted) {
    if (op === 'Unknown' && v.routes === 0) continue;
    const tr = document.createElement('tr');
    tr.dataset.opCard = op;
    tr.style.setProperty('--op-col', opColor(op));
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-label', `${DISPLAY_NAME[op] ?? op} — open details`);
    const avgAge = v.agePvr ? (v.ageSum / v.agePvr) : null;
    tr.innerHTML = `
      <td>${escapeHtml(DISPLAY_NAME[op] ?? op)}</td>
      <td>${pct(v.routes, totalRoutes)}</td>
      <td>${pct(v.pvr,    totalPvr)}</td>
      <td>${v.routes ? Math.round((v.ev / v.routes) * 100) + '%' : '—'}</td>
      <td>${avgAge != null ? avgAge.toFixed(1) + 'y' : '—'}</td>`;
    tr.addEventListener('click', () => openOperatorDrawer(op, v));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOperatorDrawer(op, v); } });
    body.appendChild(tr);
  }
}

// ── Fleet mix ────────────────────────────────────────────────────────────────
// 100%-stacked horizontal bar of PVR by propulsion + legend underneath.
// Deliberately PVR-weighted rather than route-weighted: a single 42-bus route
// on diesel shifts the picture more than a 6-bus electric school route, and
// that's what the ops folks want to see.

const PROPULSION_META = [
  { key: 'electric', label: 'Electric',  color: '#22c55e' },
  { key: 'hybrid',   label: 'Hybrid',    color: '#f59e0b' },
  { key: 'hydrogen', label: 'Hydrogen',  color: '#60a5fa' },
  { key: 'diesel',   label: 'Diesel',    color: '#6b7280' },
  { key: null,       label: 'Unknown',   color: '#3b4458' },
];

/** Render a Fleet Mix bar + legend into the given mount points. */
function renderFleetMixInto(barEl, legendEl, routes, totalPvr) {
  if (!barEl || !legendEl) return;

  // Bucket PVR by propulsion (including null → Unknown).
  const buckets = new Map(PROPULSION_META.map(m => [m.key, 0]));
  for (const r of routes) {
    const pvr = Number.isFinite(r.pvr) ? r.pvr : 0;
    const key = buckets.has(r.propulsion) ? r.propulsion : null;
    buckets.set(key, (buckets.get(key) ?? 0) + pvr);
  }

  const bar    = barEl;
  const legend = legendEl;

  bar.innerHTML    = '';
  legend.innerHTML = '';

  if (!totalPvr) {
    bar.innerHTML = `<div class="fleet-mix-seg" style="flex:1 1 100%;background:var(--surf3)"></div>`;
    legend.innerHTML = `<div class="fleet-mix-row" style="grid-column:1/-1;color:var(--mu)">No PVR data in the current selection.</div>`;
    return;
  }

  // Render segments in a stable order so the visual doesn't jump between renders.
  for (const { key, label, color } of PROPULSION_META) {
    const pvr = buckets.get(key) ?? 0;
    if (!pvr) continue;
    const pct = (pvr / totalPvr) * 100;
    const seg = document.createElement('div');
    seg.className = 'fleet-mix-seg';
    seg.style.cssText = `flex:0 0 ${pct}%;background:${color}`;
    seg.title = `${label} · ${pct.toFixed(1)}% of PVR (${pvr.toLocaleString()})`;
    bar.appendChild(seg);

    const row = document.createElement('div');
    row.className = 'fleet-mix-row';
    row.innerHTML = `
      <span class="fleet-mix-dot" style="background:${color}"></span>
      <span class="fleet-mix-row-lbl">${label}</span>
      <span class="fleet-mix-row-pct">${Math.round(pct)}%</span>`;
    legend.appendChild(row);
  }
}

/** Overview-tab convenience — renders into the top-of-tab fleet-mix block. */
function renderFleetMix(routes, totalPvr) {
  renderFleetMixInto(
    document.getElementById('fleet-mix-bar'),
    document.getElementById('fleet-mix-legend'),
    routes, totalPvr,
  );
}

// ── Operator drawer ──────────────────────────────────────────────────────────

/**
 * Open the drawer for an operator. Shows: routes + PVR KPIs, fleet mix, the
 * operator's garage list (each garage row opens the garage-drawer view), and
 * a placeholder for upcoming contracts.
 */
export function openOperatorDrawer(operator, agg) {
  if (!opDrawer) return;
  drawerName.textContent        = DISPLAY_NAME[operator] ?? operator;
  drawerSub.textContent         = '';              // route count under the name is in the KPIs now
  drawerSwatch.style.background = opColor(operator);

  const opGarages = garagesFor(operator);

  // Keep the drawer KPI vocabulary consistent across Operator / Garage views
  // — Routes operated, PVR, and "% of network routes" are shared. The 2nd
  // slot is the only one that diverges (Garages for operators, "% of
  // network PVR" for a single garage) because a garage can't have sub-garages.
  const netRoutes = _networkTotalRoutes || Object.keys(state.classifications ?? {}).length;
  const pctRoutes = netRoutes ? Math.round((agg.routes / netRoutes) * 100) + '%' : '—';
  setKpi(1, agg.routes.toLocaleString(),                           'Routes operated');
  setKpi(2, opGarages.length.toLocaleString(),                     'Garages');
  setKpi(3, agg.pvr ? agg.pvr.toLocaleString() : 'XXX',            'PVR');
  setKpi(4, pctRoutes,                                              '% of network routes');

  // Fleet mix across every route operated by this operator (independent of
  // current filters — the drawer is an operator-level dashboard, not a slice
  // of the filter state).
  const opRoutes = allRoutesForOperator(operator);
  const opPvr    = opRoutes.reduce((s, r) => s + (Number.isFinite(r.pvr) ? r.pvr : 0), 0);

  // Operator capacity = sum of its garages' authorised-vehicle capacities.
  // Only shown when EVERY garage of the operator has a capacity on file
  // (a partial sum would understate the operator's true capacity). Hidden
  // otherwise; the per-garage KPI still works.
  const allHaveCap = opGarages.length > 0 && opGarages.every(g => Number.isFinite(g.capacity) && g.capacity > 0);
  const opCapacity = allHaveCap ? opGarages.reduce((s, g) => s + g.capacity, 0) : null;
  setCapacityKpi(opCapacity);
  renderFleetMixInto(
    document.getElementById('dFleetMixBar'),
    document.getElementById('dFleetMixLegend'),
    opRoutes, opPvr,
  );

  renderGarageList(opGarages);
  renderContractsStub();
  setDrawerMode('operator');

  opDrawer.classList.add('open');
  opDrawer.setAttribute('aria-hidden', 'false');
}

/**
 * Open the drawer for a single garage. Same shape as the operator view —
 * Routes + PVR KPIs, fleet mix — plus a primary CTA to switch the map and
 * Routes tab to the set of routes operated from this garage.
 */
export function openGarageDrawer(code) {
  if (!opDrawer) return;
  const garage = _garages.find(g => g.code === code);
  if (!garage) return;

  const routes = routesForGarage(code);
  const totalPvr = routes.reduce((s, r) => s + (Number.isFinite(r.pvr) ? r.pvr : 0), 0);

  drawerName.textContent        = garage.name ?? code;
  drawerSwatch.style.background = opColor(garage.operator);
  // Subtitle is just the operator — route count is in the KPIs.
  drawerSub.textContent         = DISPLAY_NAME[garage.operator] ?? garage.operator ?? '—';

  // Network totals come from the last renderOperatorStats pass; fall back to
  // the full classifications map on first open so the percentages are never
  // NaN.
  const netRoutes = _networkTotalRoutes || Object.keys(state.classifications ?? {}).length;
  const netPvr    = _networkTotalPvr    || Object.values(state.classifications ?? {}).reduce((s, c) => s + (Number.isFinite(c.pvr) ? c.pvr : 0), 0);
  const pctRoutes = netRoutes ? Math.round((routes.length / netRoutes) * 100) + '%' : '—';
  const pctPvr    = netPvr    ? Math.round((totalPvr       / netPvr)    * 100) + '%' : '—';

  // KPIs: Routes operated · PVR · % of network PVR · % of network routes
  setKpi(1, routes.length.toLocaleString(),                   'Routes operated');
  setKpi(2, totalPvr ? totalPvr.toLocaleString() : 'XXX',     'PVR');
  setKpi(3, pctPvr,                                            '% of network PVR');
  setKpi(4, pctRoutes,                                         '% of network routes');
  // Operating-centre capacity (authorised vehicles, DVSA licence). Hidden
  // until the garage's capacity is filled in data/garage-capacity.json.
  setCapacityKpi(garage.capacity);

  renderFleetMixInto(
    document.getElementById('dFleetMixBar'),
    document.getElementById('dFleetMixLegend'),
    routes, totalPvr,
  );

  renderContractsStub();

  // Wire the CTA each time — fresh route ids per garage.
  const cta = document.getElementById('dShowRoutes');
  if (cta) {
    const routeIds = routes.map(r => r.routeId);
    cta.onclick = () => {
      // Sets the sidebar garage filter (intersecting) — the exact same
      // mechanism as the left-panel garage dropdown, so the drawer shortcut
      // and the filter stay in lockstep. The pill gives context for *why* the
      // network is narrowed; app:filterschanged re-runs the shared pipeline.
      state.selectedGarages = [{ code, name: garage.name ?? code, operator: garage.operator ?? null, routeIds }];
      document.dispatchEvent(new CustomEvent('app:garageselected', { detail: state.selectedGarages }));
      document.dispatchEvent(new CustomEvent('app:filterschanged'));
      opDrawer.classList.remove('open');
      opDrawer.setAttribute('aria-hidden', 'true');
      highlightGarageByCode(code);
    };
  }

  setDrawerMode('garage');
  opDrawer.classList.add('open');
  opDrawer.setAttribute('aria-hidden', 'false');
}

/**
 * Flip the drawer between operator (garage list + contracts visible) and
 * garage (CTA button visible) views. The shared KPI pair + fleet mix stay on
 * for both so we don't double up on markup.
 */
function setDrawerMode(mode) {
  const isGarage = mode === 'garage';
  // Network → operator → garage is a nested drill-down, so the shared blocks
  // (KPIs, fleet mix, upcoming contracts) stay on for both views. Only the
  // per-scope sections flip: operator mode shows its garage list; garage mode
  // shows the "view routes" CTA.
  const garageSec = document.getElementById('dGarageSec');
  const ctaSec    = document.getElementById('dCtaSec');
  if (garageSec) garageSec.hidden = isGarage;
  if (ctaSec)    ctaSec.hidden    = !isGarage;
  if (opDrawer)  opDrawer.dataset.mode = mode;
}

// ── Route aggregation helpers ────────────────────────────────────────────────
// Drawer views aggregate over *all* routes owned by the target entity rather
// than the filter-restricted visible set; these helpers walk the full
// classifications map once per open.

function allRoutesForOperator(operator) {
  const out = [];
  for (const [routeId, c] of Object.entries(state.classifications ?? {})) {
    if ((c.operator ?? 'Unknown') === operator) {
      out.push({ routeId, operator: c.operator, propulsion: c.propulsion, pvr: c.pvr ?? null });
    }
  }
  return out;
}

function routesForGarage(code) {
  const entries = _garageRoutes[code] ?? [];
  return entries.map(e => ({
    routeId:    e.routeId,
    operator:   e.operator ?? null,
    propulsion: e.propulsion ?? null,
    pvr:        Number.isFinite(e.pvr) ? e.pvr : null,
  }));
}

function renderGarageList(opGarages) {
  if (!dGarages) return;
  if (!opGarages.length) {
    dGarages.innerHTML = `<div class="garage-item" style="cursor:default"><span class="garage-name">No garages on file</span><span class="garage-count">—</span></div>`;
    return;
  }
  const items = opGarages
    .slice()
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map(g => {
      const routes     = _garageRoutes[g.code] ?? [];
      const routeCount = routes.length;
      const routeIds   = routes.map(r => r.routeId);
      return `<button type="button" class="garage-item" data-garage-code="${escapeHtml(g.code ?? '')}" data-route-ids="${escapeHtml(routeIds.join(','))}">
        <span class="garage-name">${escapeHtml(g.name ?? g.code ?? 'Garage')}</span>
        <span class="garage-count">${routeCount ? routeCount + ' route' + (routeCount === 1 ? '' : 's') : 'XXX'}</span>
      </button>`;
    }).join('');
  dGarages.innerHTML = items;

  // Clicking a garage swaps the drawer to a garage-detail view. From there
  // the user either explores the fleet mix or taps the CTA to replace the
  // route selection with that garage's routes.
  dGarages.querySelectorAll('.garage-item[data-garage-code]').forEach(el => {
    el.addEventListener('click', () => {
      const code = el.dataset.garageCode;
      if (code) openGarageDrawer(code);
    });
  });
}

function renderContractsStub() {
  if (!dContracts) return;
  dContracts.innerHTML = `
    <div class="rc-tender" style="cursor:default">
      <div class="rc-tr"><span class="rc-tr-l">Contract data</span><span class="bdg b-amber">XXX</span></div>
      <div class="rc-tr"><span class="rc-tr-l" style="font-size:11px">Coming soon — pending tender data</span><span class="rc-tr-v"></span></div>
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Close drawer
drawerBack?.addEventListener('click', () => {
  opDrawer?.classList.remove('open');
  opDrawer?.setAttribute('aria-hidden', 'true');
});
