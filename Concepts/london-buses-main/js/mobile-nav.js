/**
 * mobile-nav.js — Pull-up sheet + bottom nav wiring for ≤640px screens.
 *
 * The bottom nav is four equal touch targets (Map, Filters, Overview,
 * Routes). Tapping Map dismisses the sheet; any other tab opens it on the
 * matching body. The sheet itself can also be opened by pulling its handle.
 */

const sheet = document.getElementById('mobSheet');

// ── Content relocation ──────────────────────────────────────────────────────
// At ≤760px we move the real filter / overview / routes panels INTO the
// sheet bodies so the mobile sheet shows live content rather than empty
// divs. When the viewport grows back past the breakpoint we restore each
// element to its original parent. matchMedia + a single load-time wire keeps
// the move cost to one event per breakpoint cross.

const MOBILE_MQ = matchMedia('(max-width: 760px)');

// Each entry records the block we're relocating plus its original home so
// we can put it back on desktop without guessing parents or ordering.
const MOVABLE = [
  // Live count strip + scoped Clear buttons sits at the top of the Filters
  // sheet so mobile users have the same clear affordances as desktop.
  { id: 'sb-live',    into: 'ms-filters' },
  { id: 'sb-filters', into: 'ms-filters' },
  { id: 'sb-garages', into: 'ms-filters' }, // garages pill group sits right below the route filters
  { id: 'rp-overview', into: 'ms-overview' },
  { id: 'rp-routes',   into: 'ms-routes'   },
  // Global "Clear all" button lives in the desktop topbar — relocate it into
  // the mobile topbar when on a phone so the reset is one tap away anywhere.
  { id: 'resetAll',   into: 'mob-top' },
].map(e => {
  const el = document.getElementById(e.id);
  if (!el) return null;
  return { el, into: document.getElementById(e.into), origParent: el.parentNode, origNext: el.nextSibling };
}).filter(Boolean);

function applyLayout(isMobile) {
  for (const { el, into, origParent, origNext } of MOVABLE) {
    if (isMobile) {
      // Move into the sheet body if not already there.
      if (el.parentNode !== into) into.appendChild(el);
      // Mobile view wants the content visible — undo the `hidden` attribute
      // and inline display:none that the desktop tab-switchers set on
      // off-tabs (sidebar Filters/Garages, right-panel Overview/Routes).
      el.hidden = false;
      el.style.display = '';
      el.removeAttribute('hidden');
    } else {
      // Restore to its original DOM position so the desktop layout works.
      if (el.parentNode !== origParent) {
        if (origNext && origNext.parentNode === origParent) origParent.insertBefore(el, origNext);
        else origParent.appendChild(el);
      }
    }
  }
}
applyLayout(MOBILE_MQ.matches);
MOBILE_MQ.addEventListener('change', e => applyLayout(e.matches));

let sheetUp = false;
function toggleSheet(force) {
  sheetUp = force !== undefined ? force : !sheetUp;
  sheet?.classList.toggle('up', sheetUp);
  // Reflect state on the Map button — it's the "close the sheet" tab.
  const mapBtn = document.querySelector('.mob-ni[data-mn="map"]');
  if (mapBtn) mapBtn.classList.toggle('on', !sheetUp);
}

document.getElementById('mobPull')?.addEventListener('click', () => toggleSheet());

const MOB_BODIES = {
  filters:  document.getElementById('ms-filters'),
  overview: document.getElementById('ms-overview'),
  routes:   document.getElementById('ms-routes'),
};

function switchMobTab(name) {
  document.querySelectorAll('.mob-stab').forEach(t => {
    const on = t.dataset.ms === name;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
  for (const [k, el] of Object.entries(MOB_BODIES)) {
    if (!el) continue;
    const on = k === name;
    el.hidden = !on;
    el.style.display = on ? '' : 'none';
  }
  toggleSheet(true);
  // Highlight the matching bottom-nav tab so map/filter/overview/routes
  // stay visually in sync whether the user taps the tab strip or the nav.
  const navAlias = { filters: 'filter', overview: 'insights', routes: 'routes' };
  const target   = navAlias[name];
  document.querySelectorAll('.mob-ni').forEach(el => {
    el.classList.toggle('on', el.dataset.mn === target);
  });
}

document.querySelectorAll('.mob-stab').forEach(t => t.addEventListener('click', () => switchMobTab(t.dataset.ms)));

document.querySelectorAll('.mob-ni').forEach(el => {
  el.addEventListener('click', () => {
    switch (el.dataset.mn) {
      case 'map':      toggleSheet(false); document.querySelectorAll('.mob-ni').forEach(x => x.classList.remove('on')); el.classList.add('on'); break;
      case 'filter':   switchMobTab('filters');  break;
      case 'insights': switchMobTab('overview'); break;
      case 'routes':   switchMobTab('routes');   break;
    }
  });
});
