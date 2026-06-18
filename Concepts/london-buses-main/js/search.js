/**
 * search.js — Route search (topbar global + Routes-tab + mobile).
 *
 * Supports:
 *   • Single-route mode  — type or click a suggestion → map zooms, card renders.
 *   • Multi-route mode   — Space / Comma / Enter commits the typed text into a
 *                          pill. Multiple pills show side-by-side inside the
 *                          topbar search field; map renders all routes at once.
 *   • Clear              — global `#searchClear` (topbar X) + Backspace on an
 *                          empty input removes the last pill. Clearing the last
 *                          pill drops back to the "no selection" state.
 *   • Autocomplete       — prefix + substring matches from the route index,
 *                          capped at 8, shown below the topbar input with
 *                          ArrowUp/ArrowDown/Enter/Escape support.
 */

import {
  fetchRouteGeoJson, fetchStopsForRoute,
  fetchRouteDestinations, fetchRouteClassification,
  fetchRouteStopCount,
} from './api.js';
import {
  renderRoute, renderMultiRoute, clearRoute, resetMapView, highlightGaragesForRoute,
} from './map.js';
import { renderRouteCards, showNoResult, showRoutePrompt } from './route-detail.js';
import { showRpTab } from './panels.js';
import {
  state, globalInput, routeSearchInput,
  searchPills, searchClear,
} from './state.js';

/** Ordered set of route IDs in multi-route mode. */
const pillIds = new Set();
let _acIndex = -1; // autocomplete highlight index

/** Snapshot of the current search pills. Returned as a fresh Set so callers
 *  can iterate without risking mutation of the live set. Empty when no
 *  routes are pinned. Read by export.js to restrict the workbook to the
 *  user's pinned selection (overrides the broader filter-derived view). */
export function getPinnedRouteIds() {
  return new Set(pillIds);
}

const autocompleteList   = document.getElementById('globalAutocomplete');
const routeAutocomplete  = document.getElementById('routeAutocomplete');
const clearRouteSearch   = document.getElementById('clearRouteSearch');

// ── Public helpers ───────────────────────────────────────────────────────────

export function clearAll() {
  pillIds.clear();
  state.routeId = null;
  state.routeGeoJson = null;
  state.stopsFeatures = null;
  state.direction = '1';
  clearRoute();
  highlightGaragesForRoute(null);
  resetMapView();
  renderPills();
  setInputValue('');
  closeAutocomplete();
  showRoutePrompt();
  // Tell the toggles HUD to hide the Stops button — applySelection() fires
  // this when clearing via pill removal, but clearAll bypasses that path
  // (clear-all button, Escape, app:resetall) so we have to fire it here too.
  document.dispatchEvent(new CustomEvent('app:routefocuschange', { detail: false }));
  syncClearBtn();
}

// ── Internal: selection pipeline ─────────────────────────────────────────────

async function applySelection() {
  const ids = [...pillIds];
  syncClearBtn();

  if (ids.length === 0) {
    clearRoute();
    highlightGaragesForRoute(null);
    resetMapView();
    state.routeId = null;
    showRoutePrompt();
    document.dispatchEvent(new CustomEvent('app:routefocuschange', { detail: false }));
    return;
  }

  showRpTab('routes');
  // Stops are only rendered in single-route mode (multi-route draws endpoint
  // labels, not per-stop circles). Only advertise route-focus as true when
  // there's exactly one route selected — keeps the Stops toggle from
  // appearing for multi-route view where it would be a no-op.
  document.dispatchEvent(new CustomEvent('app:routefocuschange', { detail: ids.length === 1 }));

  if (ids.length === 1) {
    await renderSingle(ids[0]);
  } else {
    // Multi-route: draw every pill on the map, show stacked cards in the panel
    state.routeId = null;
    clearRoute();
    renderMultiRoute(ids);
    highlightGaragesForRoute(null);
    await renderMultiCards(ids);
  }
}

async function renderSingle(id) {
  // Short-circuit obvious 404s only when we have an index to check against.
  if (state.routeIndex.length && !state.routeIndex.includes(id)) {
    showNoResult(); state.routeId = null; return;
  }
  try {
    const stopsPromise = fetchStopsForRoute(id).catch(() => null);
    const [geojson, stops, destinations, classification] = await Promise.all([
      fetchRouteGeoJson(id),
      stopsPromise,
      fetchRouteDestinations(id),
      fetchRouteClassification(id),
    ]);
    state.routeId       = id;
    state.routeGeoJson  = geojson;
    state.stopsFeatures = stops ?? [];
    state.direction     = '1';
    renderRoute(geojson, stops ?? [], '1');
    highlightGaragesForRoute(id);
    const stopCount = Array.isArray(stops) ? stops.length : 0;
    const entry = { id, classification, destinations, stopCount };
    renderRouteCards([entry], { direction: '1' });
    // Cache the active single-route entry so the direction toggle can
    // re-render the card without re-fetching.
    state._singleRouteEntry = entry;
  } catch (err) {
    console.warn(`Route ${id} lookup failed:`, err.message);
    showNoResult(); state.routeId = null;
  }
}

async function renderMultiCards(ids) {
  // Pull destinations + classifications + stop count in parallel. All three
  // lookups hit already-cached data after the first call, so the Promise.all
  // resolves instantly on subsequent opens.
  const pairs = await Promise.all(ids.map(async id => {
    const [classification, destinations, stopCount] = await Promise.all([
      fetchRouteClassification(id).catch(() => null),
      fetchRouteDestinations(id).catch(() => null),
      fetchRouteStopCount(id).catch(() => 0),
    ]);
    return { id, classification, destinations, stopCount };
  }));
  renderRouteCards(pairs);
}

// ── Input handling ───────────────────────────────────────────────────────────

function commitPill(raw) {
  const id = (raw ?? '').trim().toUpperCase();
  if (!id) return;
  if (pillIds.has(id)) return;
  pillIds.add(id);
  setInputValue('');
  renderPills();
  applySelection();
}

function removeLastPill() {
  const arr = [...pillIds];
  if (!arr.length) return;
  pillIds.delete(arr[arr.length - 1]);
  renderPills();
  applySelection();
}

function removePill(id) {
  if (!pillIds.delete(id)) return;
  renderPills();
  applySelection();
}

// Max pills shown inline before overflow is collapsed into "+N". The topbar
// search is a fixed-width pill strip; beyond 3 pills the placeholder starts
// crowding the last chip, so we cap visible chips and summarise the rest.
const MAX_VISIBLE_PILLS = 3;

function renderPills() {
  if (!searchPills) return;
  searchPills.innerHTML = '';

  // Placeholder: nothing when pills are active — the presence of chips tells
  // the user they're in multi-route mode. When empty, show the full prompt.
  if (globalInput)      globalInput.placeholder      = pillIds.size > 0 ? '' : 'Search a route, e.g. 25 or N73…';
  if (routeSearchInput) routeSearchInput.placeholder = pillIds.size > 0 ? '' : 'Type a route, e.g. 25 or N73…';

  if (pillIds.size === 0) { searchPills.hidden = true; return; }
  searchPills.hidden = false;

  const ids      = [...pillIds];
  const visible  = ids.slice(0, MAX_VISIBLE_PILLS);
  const overflow = ids.length - visible.length;

  for (const id of visible) {
    const pill = document.createElement('span');
    pill.className = 'search-pill';
    pill.innerHTML = `<span>${escapeHtml(id)}</span>
      <button type="button" class="search-pill-x" aria-label="Remove ${escapeHtml(id)}">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>`;
    pill.querySelector('.search-pill-x').addEventListener('click', e => {
      e.stopPropagation();
      removePill(id);
    });
    searchPills.appendChild(pill);
  }

  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'search-pill search-pill-more';
    more.title = ids.slice(MAX_VISIBLE_PILLS).join(', ');
    more.textContent = `+${overflow}`;
    searchPills.appendChild(more);
  }
}

function setInputValue(v) {
  if (globalInput && globalInput.value !== v) globalInput.value = v;
  if (routeSearchInput && routeSearchInput.value !== v) routeSearchInput.value = v;
}

function syncClearBtn() {
  const active = pillIds.size > 0 || !!(globalInput?.value) || !!(routeSearchInput?.value);
  if (searchClear)      searchClear.hidden      = !active;
  if (clearRouteSearch) clearRouteSearch.hidden = !active;
  // Fan-out so filters.js can refresh its global Clear-all button visibility.
  document.dispatchEvent(new CustomEvent('app:selectionchanged'));
}

// ── Autocomplete ─────────────────────────────────────────────────────────────
// Shared render/close/highlight helpers — the global (topbar) and routes-tab
// lists use the same keyboard pipeline so the two inputs feel identical.

function renderAutocomplete(list, query) {
  if (!list) return;
  const q = (query ?? '').trim().toUpperCase();
  if (!q || !state.routeIndex.length) { closeAutocomplete(list); return; }

  const prefix = state.routeIndex.filter(id => id.startsWith(q));
  const other  = state.routeIndex.filter(id => !id.startsWith(q) && id.includes(q));
  const matches = [...prefix, ...other].slice(0, 8);
  if (!matches.length) { closeAutocomplete(list); return; }

  list.innerHTML = matches.map(id => {
    const hi   = id.replace(new RegExp(`(${escRe(q)})`, 'i'), '<mark>$1</mark>');
    const dest = state.destinations[id];
    const hint = dest?.outbound?.destination ?? dest?.inbound?.destination ?? '';
    return `<li role="option" aria-selected="false" data-value="${id}" tabindex="-1">
      <span class="ac-id">${hi}</span>
      ${hint ? `<span class="ac-dest">${escapeHtml(hint)}</span>` : ''}
    </li>`;
  }).join('');
  list.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', e => {
      e.preventDefault();
      commitPill(li.dataset.value);
      closeAllAutocomplete();
    });
  });
  _acIndex = -1;
  list.hidden = false;
}
function closeAutocomplete(list) {
  if (!list) return;
  list.hidden = true;
  list.innerHTML = '';
  _acIndex = -1;
}
function closeAllAutocomplete() {
  closeAutocomplete(autocompleteList);
  closeAutocomplete(routeAutocomplete);
}
function moveHighlight(list, delta) {
  if (!list || list.hidden) return;
  const items = [...list.querySelectorAll('li')];
  if (!items.length) return;
  _acIndex = Math.max(0, Math.min(items.length - 1, (_acIndex === -1 && delta > 0 ? -1 : _acIndex) + delta));
  items.forEach((li, i) => li.setAttribute('aria-selected', String(i === _acIndex)));
  items[_acIndex]?.scrollIntoView({ block: 'nearest' });
}

function escRe(s)     { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── Event wiring ─────────────────────────────────────────────────────────────

/**
 * Wire an input to the shared pill pipeline. Same contract as the topbar
 * search: Space / Comma / Enter commits a pill (optionally from the AC list),
 * Backspace on empty removes the last pill, ArrowUp/Down navigates the AC,
 * Escape closes it.
 */
function wireInput(input, list) {
  if (!input) return;
  input.addEventListener('input', () => {
    setInputValue(input.value);
    renderAutocomplete(list, input.value);
    syncClearBtn();
  });
  input.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === ',') {
      const v = input.value.trim();
      if (v) { e.preventDefault(); commitPill(v); closeAllAutocomplete(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = list?.querySelector('[aria-selected="true"]');
      const v = sel ? sel.dataset.value : input.value.trim();
      if (v) commitPill(v);
      closeAllAutocomplete();
    } else if (e.key === 'Backspace' && !input.value) {
      removeLastPill();
    } else if (e.key === 'ArrowDown') { e.preventDefault(); moveHighlight(list, 1); }
    else   if (e.key === 'ArrowUp')   { e.preventDefault(); moveHighlight(list, -1); }
    else   if (e.key === 'Escape')    { closeAllAutocomplete(); input.blur(); }
  });
}

wireInput(globalInput,      autocompleteList);
// On mobile the real #routeSearchInput is relocated into the pull-up sheet,
// so wiring it once covers both the desktop Routes-tab input and the mobile
// one — no separate mobile element needed.
wireInput(routeSearchInput, routeAutocomplete);

// Both Clear buttons call into the same reset.
searchClear?.addEventListener('click', () => {
  clearAll();
  globalInput?.focus();
});
clearRouteSearch?.addEventListener('click', () => {
  clearAll();
  routeSearchInput?.focus();
});

// Map popup chip → commit as pill (preserves any existing pills)
document.addEventListener('map:routeclick', e => {
  const id = String(e.detail ?? '').toUpperCase();
  if (id) commitPill(id);
});

// Close autocomplete on outside click (covers both lists).
document.addEventListener('click', e => {
  if (!e.target.closest('#globalSearch, #globalAutocomplete')) closeAutocomplete(autocompleteList);
  if (!e.target.closest('#routeSearchInput, #routeAutocomplete')) closeAutocomplete(routeAutocomplete);
});

// Global reset button in the topbar wipes every selection.
document.addEventListener('app:resetall', () => { clearAll(); });

// Direction toggle inside a focused route card — flip outbound ⇄ inbound.
// We update the name text *in place* (instead of re-rendering the card) so
// the button keeps its DOM identity and the spin animation plays cleanly.
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-rc-dir]');
  if (!btn || btn.hidden) return;
  if (!state.routeGeoJson || !state._singleRouteEntry) return;
  const entry = state._singleRouteEntry;
  const out = entry.destinations?.outbound?.destination;
  const inb = entry.destinations?.inbound?.destination;
  if (!out || !inb) return;

  // One-shot spin animation — remove + re-add so rapid clicks re-trigger.
  btn.classList.remove('is-spinning');
  void btn.offsetWidth;
  btn.classList.add('is-spinning');

  const next = state.direction === '1' ? '2' : '1';
  state.direction = next;
  renderRoute(state.routeGeoJson, state.stopsFeatures ?? [], next);

  // Patch the rc-name text in place.
  const card   = btn.closest('.route-card');
  const nameEl = card?.querySelector('[data-rc-name]');
  if (nameEl) {
    const origin = next === '1' ? inb : out;
    const dest   = next === '1' ? out : inb;
    nameEl.textContent = `${origin} → ${dest}`;
  }
});
