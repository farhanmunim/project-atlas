/**
 * garage-filter.js — Sidebar "Garage" filter (multi-select).
 *
 * A stackable, intersecting filter presented as a custom multi-select dropdown.
 * Garages are grouped under their operator (alphabetical), each a checkbox, so
 * you can tick any number across operators (e.g. operator X's garage A +
 * operator Y's garage B). Their routes are unioned, then that union is
 * intersected with the other left-panel filters by `applyFilters()` (through
 * `_filters.garageRouteIds`).
 *
 * UI:
 *   • a button summarising the selection ("All garages" / one name / "N garages"),
 *   • a click-toggled checkbox panel (reliable open/close — no focus race),
 *   • removable chips under the button for the current selection.
 *
 * Selection lives on `state.selectedGarages` (array of garage records). The
 * garage drawer's "View all routes operated here" CTA replaces the selection
 * with that single garage (stats.js) and dispatches `app:garageselected`; we
 * mirror it. Clearing — a chip ×, the scoped Clear button (`app:garagecleared`),
 * or global `app:resetall` — re-filters.
 */

import { state } from './state.js';
import { applyFilters } from './filters.js';
import { opColor } from './map.js';

const wrap  = document.getElementById('garage-ms');
const btn   = document.getElementById('garage-ms-btn');
const label = document.getElementById('garage-ms-label');
const panel = document.getElementById('garage-ms-panel');
const chips = document.getElementById('garage-ms-chips');

const SHORT_OP = { 'Stagecoach London': 'Stagecoach' };
const shortOp  = o => SHORT_OP[o] ?? o ?? 'Other';

const _byCode = new Map();   // code → garage record (incl. routeIds)
let _groups = [];            // [{ label, garages:[rec] }] — operators & garages alphabetical

/**
 * Hand the garage records + per-garage route lists in from ui.js. Keeps only
 * garages that operate ≥1 route (a garage with none can't filter).
 */
export function setGarageOptions(garages, garageRoutes) {
  _byCode.clear();
  const byOp = new Map();
  for (const g of garages ?? []) {
    const routes = garageRoutes?.[g.code] ?? [];
    if (!routes.length) continue;
    const rec = { code: g.code, name: g.name || g.code, operator: g.operator || null, routeIds: routes.map(r => r.routeId) };
    _byCode.set(g.code, rec);
    const op = g.operator || 'Other';
    if (!byOp.has(op)) byOp.set(op, []);
    byOp.get(op).push(rec);
  }
  _groups = [...byOp.entries()]
    .map(([operator, gs]) => ({ label: shortOp(operator), garages: gs.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  syncAll();
}

const selectedCodes = () => new Set((state.selectedGarages ?? []).map(g => g.code));

// ── Render ────────────────────────────────────────────────────────────────────

function renderPanel() {
  if (!panel) return;
  const sel = selectedCodes();
  let html = '';
  for (const grp of _groups) {
    html += `<div class="sb-ms-group">${escapeHtml(grp.label)}</div>`;
    for (const g of grp.garages) {
      html += `<label class="sb-ms-opt"><input type="checkbox" data-code="${escapeHtml(g.code)}"${sel.has(g.code) ? ' checked' : ''}><span class="sb-ms-opt-name">${escapeHtml(g.name)}</span></label>`;
    }
  }
  panel.innerHTML = html;
}

// Button summary + selected chips. Reads state, so the drawer-CTA / reset
// paths reflect automatically.
function render() {
  const sel = state.selectedGarages ?? [];
  if (label) {
    label.textContent = sel.length === 0 ? 'All garages'
                      : sel.length === 1 ? sel[0].name
                      : `${sel.length} garages`;
    label.classList.toggle('sb-ms-label--placeholder', sel.length === 0);
  }
  if (chips) {
    if (!sel.length) { chips.hidden = true; chips.innerHTML = ''; return; }
    chips.hidden = false;
    chips.innerHTML = sel.map(g => `
      <span class="sb-ms-chip">
        <span class="op-dot" style="background:${opColor(g.operator)}"></span>
        <span class="sb-ms-chip-name">${escapeHtml(g.name)}</span>
        <button type="button" class="sb-ms-chip-x" data-code="${escapeHtml(g.code)}" aria-label="Remove ${escapeHtml(g.name)}">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      </span>`).join('');
  }
}

function syncAll() { renderPanel(); render(); }

// ── Open / close ──────────────────────────────────────────────────────────────

function openPanel(open) {
  if (!panel || !btn) return;
  const willOpen = open ?? panel.hidden;
  if (willOpen) renderPanel();           // reflect current state on each open
  panel.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
  // Guarantee the in-flow panel has room even if the section's collapse logic
  // last set a shorter max-height while the panel was closed.
  const bd = wrap?.closest('.sb-sec-bd');
  if (bd && willOpen) bd.style.maxHeight = '400px';
}

// ── Mutations ───────────────────────────────────────────────────────────────

function toggleCode(code, on) {
  const g = _byCode.get(code);
  if (!g) return;
  const list = (state.selectedGarages ?? []).filter(x => x.code !== code);
  if (on) list.push(g);
  state.selectedGarages = list;
  render();          // panel checkbox already reflects the user's click
  applyFilters();
}

function removeCode(code) {
  state.selectedGarages = (state.selectedGarages ?? []).filter(g => g.code !== code);
  const cb = [...(panel?.querySelectorAll('input[data-code]') ?? [])].find(i => i.dataset.code === code);
  if (cb) cb.checked = false;
  render();
  applyFilters();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Event wiring ─────────────────────────────────────────────────────────────

btn?.addEventListener('click', () => openPanel());
panel?.addEventListener('change', e => {
  const cb = e.target.closest('input[data-code]');
  if (cb) toggleCode(cb.dataset.code, cb.checked);
});
chips?.addEventListener('click', e => {
  const x = e.target.closest('.sb-ms-chip-x[data-code]');
  if (x) removeCode(x.dataset.code);
});

// Close on outside click / Escape.
document.addEventListener('click', e => { if (!e.target.closest('#garage-ms')) openPanel(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel && !panel.hidden) openPanel(false); });

// Drawer CTA path — stats.js sets state.selectedGarages then dispatches this;
// filters re-run via its own app:filterschanged. We mirror the selection.
document.addEventListener('app:garageselected', syncAll);
// Scoped clear from the sidebar Clear button — state already emptied by filters.js.
document.addEventListener('app:garagecleared', syncAll);
document.addEventListener('app:resetall', () => { state.selectedGarages = []; syncAll(); });
