/**
 * toggles.js — Map-area show/hide controls for Route lines + Garages.
 *
 * Each button is a `.mctl` in the top-right of the map. Clicking flips the
 * map layer visibility, persists the choice, and updates aria-pressed / `.on`
 * for the button's own visual state. A matching event from the map (when a
 * route is focused and the overview auto-hides) keeps the button in sync
 * without persisting that transient state.
 */

import { setRoutesVisible, setGaragesVisible, setStopsPreference, isRouteActive } from './map.js';
import { toggleLinesBtn, toggleGaragesBtn, toggleStopsBtn } from './state.js';

function wire(btn, { storageKey, apply, syncEvent, persistWhen }) {
  if (!btn) return;
  const stored = localStorage.getItem(storageKey);
  const on = stored === null ? true : stored === '1';

  const paint = (state) => {
    btn.classList.toggle('on', state);
    btn.setAttribute('aria-pressed', String(state));
  };
  const setAll = (state, { persist = true } = {}) => {
    apply(state);
    paint(state);
    if (persist && (!persistWhen || persistWhen())) {
      try { localStorage.setItem(storageKey, state ? '1' : '0'); } catch (_) {}
    }
  };

  setAll(on);
  btn.addEventListener('click', () => setAll(btn.getAttribute('aria-pressed') !== 'true'));
  if (syncEvent) document.addEventListener(syncEvent, e => paint(!!e.detail));
}

wire(toggleLinesBtn, {
  storageKey: 'routes-visible',
  apply:      setRoutesVisible,
  syncEvent:  'map:routesvisibilitychange',
  persistWhen: () => !isRouteActive(),
});

wire(toggleGaragesBtn, {
  storageKey: 'garages-visible',
  apply:      setGaragesVisible,
});

// Stops toggle: visible only while a route is focused. Every fresh route
// focus force-resets the stops preference to ON — users expect to see stops
// appear when they click a route. A persistent "off" setting from an old
// session was defeating that expectation.
if (toggleStopsBtn) {
  toggleStopsBtn.hidden = true;
  let stopsOn = true;

  const paint = (on) => {
    toggleStopsBtn.classList.toggle('on', on);
    toggleStopsBtn.setAttribute('aria-pressed', String(on));
  };
  paint(stopsOn);
  setStopsPreference(stopsOn);

  toggleStopsBtn.addEventListener('click', () => {
    stopsOn = !stopsOn;
    paint(stopsOn);
    setStopsPreference(stopsOn);
  });

  document.addEventListener('app:routefocuschange', e => {
    toggleStopsBtn.hidden = !e.detail;
    if (e.detail) {
      // Reset to ON whenever a route is re-focused so the user always sees
      // stops by default — the button is their escape hatch, not a sticky
      // cross-session preference.
      stopsOn = true;
      paint(stopsOn);
      setStopsPreference(stopsOn);
    }
  });
}
