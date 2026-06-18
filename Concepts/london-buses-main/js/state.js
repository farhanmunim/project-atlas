/**
 * state.js — Shared application state + DOM refs.
 *
 * Centralises the small set of mutable fields every module reads or writes,
 * and caches DOM nodes used in more than one module. Modules import only the
 * refs they actually use.
 */

export const state = {
  routeId:         null,   // currently focused single route (uppercase id) or null
  routeGeoJson:    null,
  stopsFeatures:   null,
  direction:       '1',
  routeIndex:      [],     // all route ids
  destinations:    {},
  classifications: {},
  selectedStop:    null,   // { id, name } | null — active bus-stop filter
  selectedGarages: [],     // [{ code, name, operator, routeIds }] — active garage filter (multi-select; routes are unioned)
};

// Topbar
export const globalInput     = document.getElementById('globalInput');
export const searchPills     = document.getElementById('searchPills');
export const searchClear     = document.getElementById('searchClear');
export const exportBtn       = document.getElementById('exportBtn');
export const themeToggle     = document.getElementById('themeToggle');
export const themeToggleMob  = document.getElementById('themeToggleMob');

// Stop filter
export const stopSearchInput = document.getElementById('stop-search-input');
export const stopSearchClear = document.getElementById('stop-search-clear');
export const stopAutocomplete = document.getElementById('stop-autocomplete-list');
export const stopSelectedEl  = document.getElementById('stop-selected');

// Clear buttons — scoped separately so garage-marker selections aren't dumped
// when the user just wants to reset the route filters.
export const clearRouteFiltersBtn  = document.getElementById('clearRouteFilters');
export const clearGarageFiltersBtn = document.getElementById('clearGarageFilters');
export const resetAllBtn           = document.getElementById('resetAll');

// Sidebar
export const routeCountEl    = document.getElementById('routeCount');

// Map controls
export const toggleLinesBtn    = document.getElementById('toggleLines');
export const toggleGaragesBtn  = document.getElementById('toggleGarages');
export const toggleStopsBtn    = document.getElementById('toggleStops');

// Right panel
export const heroRoutes      = document.getElementById('hero-routes');
export const routeSearchInput = document.getElementById('routeSearchInput');
export const routePrompt     = document.getElementById('routePrompt');
export const routeResults    = document.getElementById('routeResults');
export const routeNoResult   = document.getElementById('routeNoResult');
export const routeCardTpl    = document.getElementById('tpl-route-card');

// Operator drawer
export const opDrawer        = document.getElementById('opDrawer');
export const drawerBack      = document.getElementById('drawerBack');
export const drawerName      = document.getElementById('drawerName');
export const drawerSub       = document.getElementById('drawerSub');
export const drawerSwatch    = document.getElementById('drawerSwatch');
// dRoutes/dPVR removed — the drawer now uses four generic [data-dkpi] slots
// populated by stats.js per-mode (Operator vs Garage).
export const dGarages        = document.getElementById('dGarages');
export const dContracts      = document.getElementById('dContracts');

// Footer
export const footerDate      = document.getElementById('footer-date');
export const footerNextDate  = document.getElementById('footer-next-date');

// Mobile
export const mobRoutesEl     = document.getElementById('mob-routes');
