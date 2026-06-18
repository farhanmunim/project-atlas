/**
 * panels.js — Sidebar tabs, right-panel tabs, and collapsible sections.
 *
 * Three independent concerns live here because they're all "switch the
 * visible region inside a panel" and share no data dependencies with the
 * map / filter state. Each activates on import.
 */


// ── Sidebar tab switcher (Filters / Garages) ─────────────────────────────────
const sbTabs    = document.querySelectorAll('.sb-tab');
const sbBodies  = {
  filters: document.getElementById('sb-filters'),
  garages: document.getElementById('sb-garages'),
};
function showSbTab(name) {
  sbTabs.forEach(t => {
    const on = t.dataset.stab === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
  for (const [k, el] of Object.entries(sbBodies)) {
    if (!el) continue;
    const on = k === name;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  }
  // The live-count strip swaps between "routes shown" and "garages shown"
  // based on which tab is active — the number above the pills should always
  // reflect the pills directly below it.
  document.querySelectorAll('.sb-live-count').forEach(el => {
    el.hidden = el.dataset.scope !== name;
  });
  // filters.js scopes its Clear buttons to the active tab — let it re-sync.
  document.dispatchEvent(new CustomEvent('app:sbtabchange', { detail: name }));
}
sbTabs.forEach(t => t.addEventListener('click', () => showSbTab(t.dataset.stab)));

// ── Right-panel tab switcher (Overview / Routes) ─────────────────────────────
const rpTabs   = document.querySelectorAll('.rp-tab');
const rpBodies = {
  overview: document.getElementById('rp-overview'),
  routes:   document.getElementById('rp-routes'),
};
export function showRpTab(name) {
  rpTabs.forEach(t => {
    const on = t.dataset.rp === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
  for (const [k, el] of Object.entries(rpBodies)) {
    if (!el) continue;
    const on = k === name;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  }
  // Switching tabs always closes the operator drawer
  document.getElementById('opDrawer')?.classList.remove('open');
}
rpTabs.forEach(t => t.addEventListener('click', () => showRpTab(t.dataset.rp)));

// ── Collapsible sections (sidebar) ───────────────────────────────────────────
// Clicking the header toggles a .shut class on the body, animating max-height.
document.querySelectorAll('.sb-sec-hd').forEach(hd => {
  hd.addEventListener('click', e => {
    if (e.target.closest('.sb-sec-act')) return; // 'Select all' is its own button
    const bd = hd.nextElementSibling;
    const ch = hd.querySelector('.chev');
    if (!bd) return;
    if (!bd.classList.contains('shut')) {
      bd.style.maxHeight = bd.scrollHeight + 'px';
      requestAnimationFrame(() => { bd.classList.add('shut'); ch?.classList.remove('open'); });
    } else {
      bd.classList.remove('shut');
      ch?.classList.add('open');
      setTimeout(() => { bd.style.maxHeight = bd.scrollHeight + 'px'; }, 280);
    }
  });
});
