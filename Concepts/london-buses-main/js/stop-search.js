/**
 * stop-search.js — Bus-stop filter in the sidebar.
 *
 * On input, fetches the stops registry lazily (stops.json), filters by name
 * substring (+ optional indicator), and shows up to 8 suggestions. Picking
 * one sets `state.selectedStop` and re-runs the filter pipeline so only
 * routes serving that stop remain on the map.
 *
 * Registry lookup is cached in api.js so repeated searches are instant.
 */

import { fetchStopsRegistry } from './api.js';
import { state, stopSearchInput, stopSearchClear, stopAutocomplete, stopSelectedEl } from './state.js';
import { applyFilters } from './filters.js';

let _registry = null;
let _acIndex  = -1;

async function getRegistry() {
  if (_registry) return _registry;
  try { _registry = await fetchStopsRegistry(); }
  catch (err) { console.warn('stops.json unavailable:', err.message); _registry = {}; }
  return _registry;
}

function clearAc() {
  if (!stopAutocomplete) return;
  stopAutocomplete.hidden = true;
  stopAutocomplete.innerHTML = '';
  _acIndex = -1;
}

async function renderAc(query) {
  if (!stopAutocomplete) return;
  const q = (query ?? '').trim().toLowerCase();
  if (!q || q.length < 2) return clearAc();

  const reg = await getRegistry();
  const matches = [];
  for (const [id, s] of Object.entries(reg)) {
    const name = (s.name ?? '').toLowerCase();
    if (name.includes(q)) {
      matches.push({ id, name: s.name, indicator: s.indicator, routes: s.routes?.length ?? 0 });
      if (matches.length >= 20) break;
    }
  }
  if (!matches.length) return clearAc();

  matches.sort((a, b) => b.routes - a.routes);
  stopAutocomplete.innerHTML = matches.slice(0, 8).map(m => `
    <li role="option" aria-selected="false" data-id="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}" tabindex="-1">
      <span class="ac-id">${escapeHtml(m.name)}${m.indicator ? ` <span style="opacity:.55">(${escapeHtml(m.indicator)})</span>` : ''}</span>
      <span class="ac-dest">${m.routes} route${m.routes === 1 ? '' : 's'}</span>
    </li>`).join('');

  stopAutocomplete.querySelectorAll('li').forEach(li => {
    li.addEventListener('mousedown', e => {
      e.preventDefault();
      selectStop(li.dataset.id, li.dataset.name);
    });
  });
  stopAutocomplete.hidden = false;
}

function selectStop(id, name) {
  state.selectedStop = { id, name };
  renderSelectedPill();
  clearAc();
  if (stopSearchInput) stopSearchInput.value = '';
  if (stopSearchClear) stopSearchClear.hidden = false;
  applyFilters();
}

function clearStop() {
  state.selectedStop = null;
  renderSelectedPill();
  if (stopSearchInput) stopSearchInput.value = '';
  if (stopSearchClear) stopSearchClear.hidden = true;
  clearAc();
  applyFilters();
}

function renderSelectedPill() {
  if (!stopSelectedEl) return;
  const sel = state.selectedStop;
  if (!sel) { stopSelectedEl.hidden = true; stopSelectedEl.innerHTML = ''; return; }
  stopSelectedEl.hidden = false;
  stopSelectedEl.innerHTML = `
    <span class="sb-selected-pill-label">${escapeHtml(sel.name)}</span>
    <button type="button" class="sb-selected-pill-x" aria-label="Clear stop filter">
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>`;
  stopSelectedEl.querySelector('.sb-selected-pill-x').addEventListener('click', clearStop);
}

function moveHighlight(delta) {
  if (!stopAutocomplete || stopAutocomplete.hidden) return;
  const items = [...stopAutocomplete.querySelectorAll('li')];
  if (!items.length) return;
  _acIndex = Math.max(0, Math.min(items.length - 1, (_acIndex === -1 && delta > 0 ? -1 : _acIndex) + delta));
  items.forEach((li, i) => li.setAttribute('aria-selected', String(i === _acIndex)));
  items[_acIndex]?.scrollIntoView({ block: 'nearest' });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Event wiring ─────────────────────────────────────────────────────────────

let _debounce;
stopSearchInput?.addEventListener('input', () => {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => renderAc(stopSearchInput.value), 120);
});
stopSearchInput?.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown')      { e.preventDefault(); moveHighlight(1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); moveHighlight(-1); }
  else if (e.key === 'Enter') {
    const sel = stopAutocomplete?.querySelector('[aria-selected="true"]');
    if (sel) { e.preventDefault(); selectStop(sel.dataset.id, sel.dataset.name); }
  } else if (e.key === 'Escape') { clearAc(); stopSearchInput.blur(); }
});
stopSearchClear?.addEventListener('click', clearStop);
document.addEventListener('click', e => {
  if (!e.target.closest('#stop-search-input, #stop-autocomplete-list')) clearAc();
});
// Global Clear Filters button wipes state.selectedStop; reflect that in the UI.
document.addEventListener('app:stopcleared', () => {
  if (stopSearchClear) stopSearchClear.hidden = true;
  renderSelectedPill();
});
