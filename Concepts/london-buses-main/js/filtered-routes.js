/**
 * filtered-routes.js — List the routes matching the active sidebar filters in
 * the Routes tab, so applying a filter (bus stop, operator, type, propulsion,
 * deck, frequency) shows *which* routes it kept — not just coloured lines on
 * the map. Each row opens that route's full card.
 *
 * Routes-tab content priority:
 *   1. Pinned / selected routes (search pills, garage pick, map click) → full
 *      cards (owned by search.js + route-detail.js). We stay out of the way.
 *   2. Filters active, nothing pinned                                  → this list.
 *   3. Nothing active                                                  → search prompt.
 *
 * Recomputed on `app:filterchange` (filter pills / stop) and
 * `app:selectionchanged` (pins added/removed) so the three states stay in sync.
 */

import { state } from './state.js';
import { getVisibleRouteProps, opColor } from './map.js';
import { getPinnedRouteIds } from './search.js';
import { showRoutePrompt } from './route-detail.js';
import { showRpTab } from './panels.js';

const ROUTE_FILTER_KEYS = ['routetype', 'operator', 'frequency', 'deck', 'propulsion'];

const wrap            = document.getElementById('routeFilteredList');
const listEl          = document.getElementById('rflList');
const countEl         = document.getElementById('rflCount');
const labelEl         = document.getElementById('rflLabel');
const routeResults    = document.getElementById('routeResults');
const routePromptEl   = document.getElementById('routePrompt');
const routeNoResultEl = document.getElementById('routeNoResult');

// Tracks whether the list is currently the Routes-tab occupant, so we only
// auto-switch to the Routes tab on the *transition* into the filtered state —
// never yanking the user back while they're toggling further pills or reading
// the Overview.
let _listActive = false;

function anyFilterActive() {
  if (state.selectedStop || state.selectedGarages.length) return true;
  return ROUTE_FILTER_KEYS.some(k => document.querySelector(`.pill.on[data-filter="${k}"]`));
}

// Natural sort: numeric routes first (numerically), then lettered, both with
// zero-padded digit runs so 25 < 100 and N5 < N73.
const sortKey = id => [/^\d/.test(id) ? 0 : 1, String(id).replace(/\d+/g, m => m.padStart(6, '0'))];
function cmp(a, b) { const [ka, la] = sortKey(a), [kb, lb] = sortKey(b); return ka - kb || la.localeCompare(lb); }

function hide() { if (wrap) wrap.hidden = true; _listActive = false; }

function refresh() {
  if (!wrap || !listEl) return;
  // 1. An explicit route selection owns the Routes tab — leave it alone.
  if (getPinnedRouteIds().size > 0) { hide(); return; }
  // 2. No filters → the default search prompt.
  if (!anyFilterActive()) { hide(); showRoutePrompt(); return; }
  // 3. Filters active → render the matching routes.
  render([...getVisibleRouteProps().keys()].sort(cmp));
}

function render(ids) {
  // Take over the Routes-tab body from the prompt / card states.
  if (routePromptEl)   routePromptEl.style.display = 'none';
  if (routeResults)    routeResults.hidden = true;
  if (routeNoResultEl) routeNoResultEl.hidden = true;

  if (countEl) countEl.textContent = ids.length.toLocaleString();
  if (labelEl) labelEl.textContent = ids.length === 1 ? 'route matches your filters' : 'routes match your filters';

  listEl.innerHTML = ids.length
    ? ids.map(id => {
        const c    = state.classifications[id] ?? {};
        const dest = destFor(id);
        return `<li><button type="button" class="rfl-item" data-route-id="${esc(id)}">
          <span class="rfl-dot" style="background:${opColor(c.operator)}"></span>
          <span class="rfl-id">${esc(id)}</span>
          <span class="rfl-dest">${esc(dest)}</span>
        </button></li>`;
      }).join('')
    : `<li class="rfl-empty">No routes match the current filters.</li>`;

  wrap.hidden = false;
  // Surface the result on first entry into the filtered state.
  if (!_listActive) { showRpTab('routes'); _listActive = true; }
}

function destFor(id) {
  const d = state.destinations[id];
  return d?.outbound?.destination ?? d?.inbound?.destination ?? '';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Row click → open that route (commit it as a search pill via the existing
// map-click path, which renders the single-route card).
listEl?.addEventListener('click', e => {
  const btn = e.target.closest('.rfl-item[data-route-id]');
  if (btn) document.dispatchEvent(new CustomEvent('map:routeclick', { detail: btn.dataset.routeId }));
});

document.addEventListener('app:filterchange',      refresh);
document.addEventListener('app:selectionchanged',  refresh);
document.addEventListener('app:resetall',          hide);
