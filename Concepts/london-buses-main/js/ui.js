/**
 * ui.js — Boot orchestrator.
 *
 * Side-effect imports wire each module's own event listeners. Data loading
 * happens here so the modules stay pure: `ui.js` fetches the static JSON
 * files, hydrates `state`, and hands the derived shapes to the renderers.
 *
 * Order matters:
 *   1. Map first so the tile layer starts painting while the rest loads.
 *   2. Small metadata files (index + destinations + classifications) —
 *      enough to render the sidebar route count + operator cards without
 *      waiting on the 1.3 MB overview GeoJSON.
 *   3. Overview GeoJSON (low priority).
 *   4. Garages (independent — unblocks route markers on the map).
 */

import './panels.js';        // sidebar tabs, right-panel tabs, section collapse
import './filters.js';       // pill-based filter engine
import './paint-mode.js';    // colour-routes-by toggle (both copies synced)
import './toggles.js';       // map-area route/garage visibility controls
import './search.js';        // topbar + routes-tab search (multi-route pills)
import './stop-search.js';   // bus-stop filter in sidebar
import './garage-filter.js'; // garage-selection pill in sidebar (parity with stop filter)
import './route-detail.js';  // route-card renderer (imported for side-effect-free exports)
import './filtered-routes.js'; // lists filter-matched routes in the Routes tab
import './mobile-nav.js';    // pull-up sheet + bottom nav
import './export.js';        // XLSX export
import './tooltip.js';       // custom [data-tip] hover tooltip used by route-card labels

import { initMap, renderOverview, renderGarages, setGaragesVisible } from './map.js';
import { fetchRouteIndex, fetchAllDestinations, fetchRouteClassifications, fetchGarageLocations } from './api.js';
import { state, footerDate, footerNextDate, themeToggle, themeToggleMob } from './state.js';
import { renderOperatorStats, setGarageData } from './stats.js';
import { setGarageOptions } from './garage-filter.js';
import { applyFilters } from './filters.js';

// ── Theme ────────────────────────────────────────────────────────────────────
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('app-theme', t); } catch (_) {}
}
function toggleTheme() {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}
themeToggle?.addEventListener('click', toggleTheme);
themeToggleMob?.addEventListener('click', toggleTheme);

// ── Map ──────────────────────────────────────────────────────────────────────
initMap();

// Metadata preload — sidebar + operator cards can render from these alone.
Promise.all([
  fetchRouteIndex(),
  fetchAllDestinations(),
  fetchRouteClassifications(),
]).then(([ids, dests, classifications]) => {
  state.routeIndex      = ids;
  state.destinations    = dests;
  state.classifications = classifications;

  // Initial hero + operator cards from the full classifications set — before
  // any filters apply, every route is "visible".
  const all = Object.entries(classifications).map(([id, c]) => ({
    routeId:    id,
    routeType:  c.type,
    isPrefix:   c.isPrefix,
    deck:       c.deck,
    frequency:  c.frequency,
    operator:   c.operator,
    propulsion: c.propulsion,
    lengthBand: c.lengthBand,
    pvr:        c.pvr ?? null,
    vehicleAgeYears: c.vehicleAgeYears ?? null,
  }));
  renderOperatorStats(all);
  updateFooterDates();
}).catch(err => console.warn('Metadata preload failed:', err));

// Overview GeoJSON (the heavy one) — fetched last so it doesn't starve the
// lighter metadata requests above.
fetch('./data/routes-overview.geojson', { priority: 'low' })
  .then(r => r.json())
  .then(overview => {
    renderOverview(overview);
    applyFilters();                         // refreshes counts + stats from the map
  })
  .catch(err => console.warn('Overview load failed:', err));

// Garages — independent of the overview; route-count per garage is joined in
// here so garage popups can show per-route chips + total PVR.
Promise.all([fetchGarageLocations(), fetchRouteClassifications()]).then(([garages, classifications]) => {
  if (!garages.length) return;
  const garageRoutes = {};
  for (const [routeId, c] of Object.entries(classifications)) {
    if (!c.garageCode) continue;
    (garageRoutes[c.garageCode] ??= []).push({
      routeId,
      pvr:        c.pvr ?? null,
      operator:   c.operator ?? null,
      type:       c.type ?? null,
      propulsion: c.propulsion ?? null,
    });
  }
  const routeSortKey = id => [/^\d/.test(id) ? 0 : 1, id.padStart(6, '0')];
  for (const list of Object.values(garageRoutes)) {
    list.sort((a, b) => {
      const [ka, la] = routeSortKey(a.routeId), [kb, lb] = routeSortKey(b.routeId);
      return ka - kb || la.localeCompare(lb);
    });
  }
  renderGarages(garages, garageRoutes);
  setGaragesVisible(localStorage.getItem('garages-visible') !== '0');

  // Hand the garage records to stats.js so operator cards / drawer can show
  // real garage counts, and to garage-filter.js for the sidebar picker.
  setGarageData(garages, garageRoutes);
  setGarageOptions(garages, garageRoutes);
  applyFilters(); // refresh op cards now that garage counts are known
});

// ── Footer: last / next refresh ──────────────────────────────────────────────
function updateFooterDates() {
  fetch('./data/build-meta.json').then(r => r.json()).then(meta => {
    const ts = meta?.routeOverview?.updatedAt;
    if (!ts) return;
    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    if (footerDate)     footerDate.textContent     = fmt(new Date(ts));
    if (footerNextDate) footerNextDate.textContent = fmt(nextMondayAt(5));
  }).catch(() => { /* meta file missing is non-fatal */ });
}
function nextMondayAt(utcHour) {
  const now = new Date();
  const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
  const daysAhead = (1 - d.getUTCDay() + 7) % 7 || (d > now ? 0 : 7);
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}
