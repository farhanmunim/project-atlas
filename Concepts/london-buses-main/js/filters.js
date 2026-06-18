/**
 * filters.js — Pill-based filter handling.
 *
 * Reads active `.pill.on` elements from #sb-filters and #sb-garages, feeds
 * them into the map layer (route overview + garage markers), and updates the
 * sidebar live-count strip + right-panel hero + operator cards. Also exposes
 * a global Clear Filters button that resets every filter pill + the bus-stop
 * filter in one click.
 *
 * Route filter groups (data-filter on each pill):
 *   routetype · operator · frequency · deck · propulsion · tender
 *
 * Garage filter is a separate group (garageoperator). Bus-stop filter is owned
 * by stop-search.js and lives on state.selectedStop; we pick it up here on
 * every pass so any change flows through a single pipeline.
 */

import { filterOverview, filterGarages, getVisibleRouteProps, countVisibleGarages } from './map.js';
import { fetchStopsRegistry } from './api.js';
import { state, routeCountEl, mobRoutesEl,
         clearRouteFiltersBtn, clearGarageFiltersBtn, resetAllBtn } from './state.js';
import { renderOperatorStats } from './stats.js';
import { showRpTab } from './panels.js';

const ROUTE_FILTER_KEYS   = ['routetype', 'operator', 'frequency', 'deck', 'propulsion'];
const GARAGE_FILTER_KEYS  = ['garageoperator'];
const ALL_FILTER_KEYS     = [...ROUTE_FILTER_KEYS, ...GARAGE_FILTER_KEYS];

function activeSet(key, root = document) {
  const pills = [...root.querySelectorAll(`.pill.on[data-filter="${key}"]`)];
  return pills.length ? new Set(pills.map(p => p.dataset.val)) : null;
}

async function stopRouteIds(stopId) {
  const reg = await fetchStopsRegistry().catch(() => ({}));
  const list = reg?.[stopId]?.routes ?? [];
  return new Set(list.map(r => String(r).toUpperCase()));
}

export async function applyFilters() {
  const stopIds = state.selectedStop ? await stopRouteIds(state.selectedStop.id) : null;
  // Garage filter intersects the same way as the stop filter, but its route
  // list is already known (carried on state.selectedGarages by garage-filter.js
  // / the garage drawer) so no async lookup is needed. Multiple garages are
  // OR'd together (union of their routes), then AND'd with the other filters.
  const garageIds = state.selectedGarages?.length
    ? new Set(state.selectedGarages.flatMap(g => g.routeIds ?? []).map(r => String(r).toUpperCase()))
    : null;

  const filters = {
    types:          activeSet('routetype'),
    deck:           activeSet('deck'),
    frequency:      activeSet('frequency'),
    operator:       activeSet('operator'),
    propulsion:     activeSet('propulsion'),
    stopRouteIds:   stopIds,
    garageRouteIds: garageIds,
  };
  const { routeCount } = filterOverview(filters);
  filterGarages(activeSet('garageoperator'));

  updateRouteCount(routeCount);
  syncClearBtn();

  const visible = [...getVisibleRouteProps().entries()].map(([id, props]) => ({
    ...props,
    pvr:             state.classifications[id]?.pvr ?? null,
    vehicleAgeYears: state.classifications[id]?.vehicleAgeYears ?? null,
  }));
  renderOperatorStats(visible);
}

function updateRouteCount(n) {
  const s = n.toLocaleString();
  if (routeCountEl) routeCountEl.textContent = s;
  if (mobRoutesEl)  mobRoutesEl.textContent  = s;
  const rpRoutes   = document.getElementById('rp-sub-routes');
  const heroRoutes = document.getElementById('hero-routes');
  if (rpRoutes)   rpRoutes.textContent   = s;
  if (heroRoutes) heroRoutes.textContent = s;

  // Keep the sidebar's garage-count count in sync too — the tab the user is on
  // determines which strip is visible, but both numbers always reflect current
  // state so a tab switch doesn't show stale data.
  const gCount = countVisibleGarages();
  const gEl    = document.getElementById('garageCount');
  if (gEl) gEl.textContent = gCount.toLocaleString();
  // Mobile peek strip (Routes · Operators · Garages) — mirror the desktop's
  // Network Overview KPIs at the top of the pull-up sheet.
  const mobGaragesEl = document.getElementById('mob-garages');
  if (mobGaragesEl) mobGaragesEl.textContent = gCount.toLocaleString();

  document.dispatchEvent(new CustomEvent('app:filterchange', { detail: { routes: n, garages: gCount } }));
}

function anyRouteActive() {
  for (const k of ROUTE_FILTER_KEYS) {
    if (document.querySelector(`.pill.on[data-filter="${k}"]`)) return true;
  }
  return !!state.selectedStop || state.selectedGarages.length > 0;
}
function anyGarageActive() {
  return !!document.querySelector(`.pill.on[data-filter="garageoperator"]`);
}

// Show each Clear button only when its own scope has anything to clear AND
// the sidebar tab it belongs to is currently active. Route-filter pills live
// on the Filters tab, garage-marker pills live on the Garages tab, so the
// buttons track the live-count strip above them — never crossing tabs. The
// topbar "Clear all" is global: any active state across the app shows it.
function activeSbTab() {
  return document.querySelector('.sb-tab.on')?.dataset.stab ?? 'filters';
}
function syncClearBtn() {
  const tab    = activeSbTab();
  const route  = anyRouteActive();
  const garage = anyGarageActive();
  const pills  = document.querySelectorAll('#searchPills .search-pill').length > 0;
  const search = !!(document.getElementById('globalInput')?.value || document.getElementById('routeSearchInput')?.value);

  if (clearRouteFiltersBtn)  clearRouteFiltersBtn.hidden  = !(route  && tab === 'filters');
  if (clearGarageFiltersBtn) clearGarageFiltersBtn.hidden = !(garage && tab === 'garages');
  if (resetAllBtn)           resetAllBtn.hidden           = !(route || garage || pills || search);
}

function clearPillsByKeys(keys) {
  const sel = keys.map(k => `.pill.on[data-filter="${k}"]`).join(',');
  document.querySelectorAll(sel).forEach(p => p.classList.remove('on'));
}

// ── Event wiring ─────────────────────────────────────────────────────────────

document.addEventListener('click', e => {
  const pill = e.target.closest('.pill[data-filter]');
  if (!pill) return;
  pill.classList.toggle('on');
  pill.classList.remove('tap');
  void pill.offsetWidth;
  pill.classList.add('tap');
  applyFilters();
});

clearRouteFiltersBtn?.addEventListener('click', () => {
  clearPillsByKeys(ROUTE_FILTER_KEYS);
  if (state.selectedStop) {
    state.selectedStop = null;
    document.dispatchEvent(new CustomEvent('app:stopcleared'));
  }
  if (state.selectedGarages.length) {
    state.selectedGarages = [];
    document.dispatchEvent(new CustomEvent('app:garagecleared'));
  }
  applyFilters();
});
clearGarageFiltersBtn?.addEventListener('click', () => {
  clearPillsByKeys(GARAGE_FILTER_KEYS);
  applyFilters();
});

// Global reset — single button that undoes every user interaction on the page:
// route filters, garage-marker filters, stop filter, and the multi-route pill
// selection. We lean on app:resetall so search.js can react without a direct
// import loop.
resetAllBtn?.addEventListener('click', () => {
  clearPillsByKeys(ALL_FILTER_KEYS);
  if (state.selectedStop) {
    state.selectedStop = null;
    document.dispatchEvent(new CustomEvent('app:stopcleared'));
  }
  document.dispatchEvent(new CustomEvent('app:resetall'));
  applyFilters();
  // A full reset should return the user to the default view — the Routes tab
  // is a context (a route was searched), so it doesn't make sense to linger
  // there once that context is gone.
  showRpTab('overview');
});

// Allow other modules (stop-search) to trigger a re-run without importing us.
document.addEventListener('app:filterschanged', applyFilters);
// search.js emits this whenever the pill set or any input value changes — we
// only need to refresh the Clear-all visibility, not re-filter the map.
document.addEventListener('app:selectionchanged', syncClearBtn);
// Tab switch in the sidebar: re-scope which Clear button is allowed to show.
document.addEventListener('app:sbtabchange',      syncClearBtn);
