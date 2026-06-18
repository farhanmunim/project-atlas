/**
 * map.js — Map initialisation, overview layer, route highlighting
 */

import { state } from './state.js';

const LONDON = [51.505, -0.118];
const ZOOM   = 11;

const COLOR_OUTBOUND = '#dc2626';
const COLOR_INBOUND  = '#2563eb';

// Per-type colors — a deliberately high-contrast categorical palette. Each hue
// sits in its own wheel zone (red / mustard / teal / violet / green) and is
// dark enough to punch through the CARTO Voyager cream basemap.
const TYPE_COLORS = {
  regular:    '#dc2626', // red-600    — iconic London bus red
  prefix:     '#a16207', // yellow-700 — dark mustard, no warm-red bleed
  twentyfour: '#0e7490', // cyan-700   — deep teal, sits above water tiles
  night:      '#6d28d9', // violet-700 — deep purple, separated from teal
  school:     '#15803d', // green-700  — forest green, distinct from parks
};

// Canonical operator palette — single source of truth used by route lines,
// garage markers, overview table, operator cards, drawer swatches, route-card
// operator pill and sidebar filter pill dots. Matches the colours declared
// inline in the sidebar filter pills in index.html. Exported so stats.js
// and route-detail.js share the same dictionary instead of keeping their
// own (previously divergent) copies.
export const OPERATOR_COLORS = {
  'Arriva':            '#2563eb',
  'Arriva London':     '#2563eb',
  'First':             '#7c3aed',
  'First London':      '#7c3aed',
  'Go-Ahead':          '#e8192c',
  'Go-Ahead London':   '#e8192c',
  'Metroline':         '#0891b2',
  'Stagecoach':        '#1b3d72',
  'Stagecoach London': '#1b3d72',
  'Transport UK':      '#db2777',
  'RATP':              '#16a34a',
  'RATP Dev':          '#16a34a',
  'Uno':               '#d97706',
  'Uno Buses':         '#d97706',
};
export const OPERATOR_FALLBACK_COLOR = '#64748b'; // slate-500 — unknown operator
/** Look up an operator's brand colour with the canonical fallback. */
export const opColor = (name) => OPERATOR_COLORS[name] ?? OPERATOR_FALLBACK_COLOR;

// Paint mode: how should route lines be coloured?
//   'operator' — by operator brand livery  [default]
//   'type'     — by route category (regular/prefix/night/24h/school)
let _paintMode = 'operator';

function typeColor(props) {
  if (props.isPrefix)                   return TYPE_COLORS.prefix;
  if (props.routeType === 'night')      return TYPE_COLORS.night;
  if (props.routeType === 'twentyfour') return TYPE_COLORS.twentyfour;
  if (props.routeType === 'school')     return TYPE_COLORS.school;
  return TYPE_COLORS.regular;
}
function operatorColor(props) {
  const op = props.operator;
  return (op && OPERATOR_COLORS[op]) || OPERATOR_FALLBACK_COLOR;
}
function featureColor(props) {
  return _paintMode === 'operator' ? operatorColor(props) : typeColor(props);
}

// Look up a route's operator colour from the overview geojson. Used by popup
// chip renderers so chips are always operator-coloured regardless of the
// current paint mode (which only affects the lines on the map).
function operatorColorForRoute(routeId) {
  if (!_overviewGeoJson) return OPERATOR_FALLBACK_COLOR;
  const id = String(routeId).toUpperCase();
  const f  = _overviewGeoJson.features.find(x => x.properties?.routeId === id);
  return f ? operatorColor(f.properties) : OPERATOR_FALLBACK_COLOR;
}

// Active filter state — null means "all pass"
let _filters = {
  types:          null,
  deck:           null,
  frequency:      null,
  operator:       null,
  propulsion:     null,
  stopRouteIds:   null, // Set<routeId> of routes serving the selected stop, or null
  garageRouteIds: null, // Set<routeId> of routes operated from the selected garage, or null
};

let _map             = null;
let _overviewLayer   = null;
let _overviewGeoJson = null;
let _outlineLayer    = null; // multi-route dark outline
let _routeLayer      = null;
let _stopsLayer      = null;
let _stopsVisible    = true;
let _identifyPopup   = null;
let _routeActive     = false; // true while a single or multi route is displayed
let _garagesLayer    = null;
let _stopsPref       = true;  // user's global preference (persisted)

const _routeCanvas = L.canvas({ padding: 0.5 });
const _stopsCanvas = L.canvas({ padding: 0.5 });

// ── Geometry helpers ──────────────────────────────────────────────────────────

function ptSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// When a filter set is active, routes must match one of the selected values.
// Null/missing values are represented by the special value '__unknown__' —
// the user must explicitly tick "Unknown" to include them.
function matchesFilterSet(set, value) {
  if (!set) return true;
  if (value == null || value === '') return set.has('__unknown__');
  return set.has(value);
}

function featurePassesFilter(props) {
  if (_filters.types) {
    const { routeType, isPrefix } = props;
    const typeKey = isPrefix                    ? 'prefix'
                  : routeType === 'night'       ? 'night'
                  : routeType === 'twentyfour'  ? 'twentyfour'
                  : routeType === 'school'      ? 'school'
                  :                               'regular';
    if (!_filters.types.has(typeKey)) return false;
  }
  if (!matchesFilterSet(_filters.deck,       props.deck))       return false;
  if (!matchesFilterSet(_filters.frequency,  props.frequency))  return false;
  if (!matchesFilterSet(_filters.operator,   props.operator))   return false;
  if (!matchesFilterSet(_filters.propulsion, props.propulsion)) return false;
  if (_filters.stopRouteIds   && !_filters.stopRouteIds.has(props.routeId))   return false;
  if (_filters.garageRouteIds && !_filters.garageRouteIds.has(props.routeId)) return false;
  return true;
}

function findRoutesNearPoint(containerPt, pixelRadius) {
  if (!_overviewGeoJson || !_map) return new Map();
  const found = new Map();
  const { x: px, y: py } = containerPt;

  for (const feature of _overviewGeoJson.features) {
    const props = feature.properties;
    if (!featurePassesFilter(props)) continue;
    const { routeId } = props;
    if (found.has(routeId)) continue;

    const coords = feature.geometry.coordinates;
    outer: for (let i = 0; i < coords.length - 1; i++) {
      const a = _map.latLngToContainerPoint([coords[i][1],   coords[i][0]]);
      const b = _map.latLngToContainerPoint([coords[i+1][1], coords[i+1][0]]);
      if (ptSegDist(px, py, a.x, a.y, b.x, b.y) <= pixelRadius) {
        found.set(routeId, props);
        break outer;
      }
    }
  }
  return found;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initMap() {
  _map = L.map('map', {
    center: LONDON, zoom: ZOOM, zoomControl: false, preferCanvas: true,
  });

  L.control.zoom({ position: 'bottomright' }).addTo(_map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> © <a href="https://carto.com/" target="_blank">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
    detectRetina: true,
  }).addTo(_map);

  _map.on('click', e => {
    if (_stopsLayer) return;
    if (_identifyPopup) { _map.closePopup(_identifyPopup); _identifyPopup = null; }

    const pt     = _map.latLngToContainerPoint(e.latlng);
    const routes = findRoutesNearPoint(pt, 6);
    if (routes.size === 0) return;

    const chips = [...routes.entries()]
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([id, props]) => {
        // Always colour popup chips by operator — it's a directory of routes,
        // not a visualisation of route type. Keeps chips consistent across
        // popups regardless of the current paint-mode selection.
        const color = operatorColor(props);
        return `<span class="map-id-popup__chip" data-route="${id}" style="--chip-col:${color}">${id}</span>`;
      }).join('');

    const html = `<div class="map-id-popup"><p class="map-id-popup__label">Routes here</p><div class="map-id-popup__chips">${chips}</div></div>`;
    _identifyPopup = L.popup({ closeButton: true, className: 'map-id-popup-wrap', maxWidth: 260, offset: [0, -4] })
      .setLatLng(e.latlng).setContent(html).openOn(_map);

    // Wire chip clicks after popup is in DOM
    setTimeout(() => {
      document.querySelectorAll('.map-id-popup__chip[data-route]').forEach(chip => {
        chip.addEventListener('click', () => {
          _map.closePopup(_identifyPopup);
          _identifyPopup = null;
          document.dispatchEvent(new CustomEvent('map:routeclick', { detail: chip.dataset.route }));
        });
      });
    }, 0);
  });

  return _map;
}

// ── Overview layer ────────────────────────────────────────────────────────────

function overviewStyle(feature) {
  // Opacity depends only on whether a route is currently focused:
  //   • No route focused  → full overview (0.8)
  //   • Route focused     → faint context underlay (0.2)
  // The Show/Hide routes toggle (setRoutesVisible) decides whether the
  // overview layer is on the map at all, so it controls the *presence* of
  // this faint context without requiring any opacity gymnastics.
  return {
    color:   featureColor(feature.properties),
    weight:  2.25,
    opacity: _routeActive ? 0.2 : 0.8,
    lineCap: 'round',
  };
}

export function renderOverview(geojson) {
  if (_overviewLayer) return;
  _overviewGeoJson = geojson;
  _overviewLayer = L.geoJSON(geojson, { style: overviewStyle, interactive: false }).addTo(_map);
  _overviewLayer.bringToBack();
  if (!_routesVisible) _map.removeLayer(_overviewLayer);
}

/**
 * Re-render the overview layer with the given filters.
 * Returns { routeCount } for the sidebar stat.
 * @param {{ types: Set, operators: Set|null, deck: string|null }} filters
 */
export function filterOverview(filters) {
  if (!_overviewGeoJson) return { routeCount: 0 };
  _filters = filters;

  if (_overviewLayer) { _map.removeLayer(_overviewLayer); _overviewLayer = null; }

  const seen = new Set();
  const features = _overviewGeoJson.features.filter(f => {
    if (!featurePassesFilter(f.properties)) return false;
    seen.add(f.properties.routeId);
    return true;
  });

  _overviewLayer = L.geoJSON(
    { type: 'FeatureCollection', features },
    { style: overviewStyle, interactive: false }
  ).addTo(_map);
  _overviewLayer.bringToBack();
  if (!_routesVisible) _map.removeLayer(_overviewLayer);

  return { routeCount: seen.size };
}

// Re-apply the overview style using current route/filter state.
// Called after routes are selected/cleared or filters change.
export function dimOverview()     { _overviewLayer?.setStyle(f => overviewStyle(f)); }
export function restoreOverview() { _overviewLayer?.setStyle(f => overviewStyle(f)); }

// ── Selected route ────────────────────────────────────────────────────────────

export function clearRoute() {
  if (_outlineLayer)  { _map.removeLayer(_outlineLayer); _outlineLayer  = null; }
  if (_routeLayer)    { _map.removeLayer(_routeLayer);   _routeLayer    = null; }
  if (_stopsLayer)    { _map.removeLayer(_stopsLayer);   _stopsLayer    = null; }
  if (_identifyPopup) { _map.closePopup(_identifyPopup); _identifyPopup = null; }
  _stopsVisible = true;
  const wasActive = _routeActive;
  _routeActive  = false;
  restoreOverview();
  if (wasActive) _exitRouteFocus();
}

export function renderRoute(routeGeoJson, stopsFeatures, direction) {
  _suppressRoutesTransition = true;
  clearRoute();
  _suppressRoutesTransition = false;
  _routeActive = true;
  dimOverview();
  _enterRouteFocus();

  const dir   = String(direction);
  const color = dir === '2' ? COLOR_INBOUND : COLOR_OUTBOUND;
  const features = routeGeoJson.features.filter(f => String(f.properties.direction) === dir);

  if (features.length) {
    _routeLayer = L.geoJSON(
      { type: 'FeatureCollection', features },
      { style: { color, weight: 6, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }, renderer: _routeCanvas }
    ).addTo(_map);
  }

  _stopsLayer = L.layerGroup();
  for (const f of stopsFeatures) {
    const [lon, lat] = f.geometry.coordinates;
    const p         = f.properties;
    const name      = p.name      ?? p.NAME      ?? 'Stop';
    const id        = p.id        ?? p.NAPTAN_ID ?? '';
    const indicator = p.indicator ?? p.STOP_LETTER ?? '';
    const towards   = p.towards   ?? '';

    // Routes serving this stop — stored as comma-separated string
    const routeIds = (p.routes ?? p.ROUTES ?? '')
      .split(',').map(r => r.trim()).filter(Boolean)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const marker = L.circleMarker([lat, lon], {
      radius: 5, fillColor: '#fff', color, weight: 2, opacity: 1, fillOpacity: 1, renderer: _stopsCanvas,
    });

    const displayName = indicator ? `${name} <span style="opacity:.55">(${indicator})</span>` : name;

    const routeChips = routeIds.length
      ? `<div class="map-popup__routes">${routeIds.map(r => {
          const col = operatorColorForRoute(r);
          return `<span class="map-popup__route-chip" data-route="${r}" style="--chip-col:${col}">${r}</span>`;
        }).join('')}</div>`
      : '';

    // NaPTAN id deliberately omitted from the bus-stop popup — the identifier
    // is only useful to integrators and clutters the consumer view.
    marker.bindPopup(
      `<span class="map-popup__name">${displayName}</span>` +
      `${towards ? `<span class="map-popup__id" style="color:var(--t2)">${towards}</span>` : ''}` +
      routeChips,
      { closeButton: true, maxWidth: 260 }
    );

    // Wire route chip clicks after popup opens
    marker.on('popupopen', () => {
      setTimeout(() => {
        document.querySelectorAll('.map-popup__route-chip[data-route]').forEach(chip => {
          chip.addEventListener('click', () => {
            marker.closePopup();
            document.dispatchEvent(new CustomEvent('map:routeclick', { detail: chip.dataset.route }));
          });
        });
      }, 0);
    });

    _stopsLayer.addLayer(marker);
  }

  _stopsLayer.addTo(_map);
  _stopsVisible = true;
  if (!_stopsPref)    setStopsVisible(false);
  if (!_routesVisible) setRoutesVisible(false); // re-apply when user has Routes off
  fitToRoute();
}

/**
 * Highlight a set of routes from the overview layer without loading stops.
 * Renders a dark outline beneath each coloured line for visual distinction,
 * and places route-number labels at each route's start and end points.
 */
export function renderMultiRoute(ids) {
  if (_routeLayer) { _map.removeLayer(_routeLayer); _routeLayer = null; }
  if (_stopsLayer) { _map.removeLayer(_stopsLayer); _stopsLayer = null; }
  if (_identifyPopup) { _map.closePopup(_identifyPopup); _identifyPopup = null; }

  if (!_overviewGeoJson || !ids.length) {
    const wasActive = _routeActive;
    _routeActive = false;
    restoreOverview();
    if (wasActive) _exitRouteFocus();
    return;
  }

  const wasActive = _routeActive;
  _routeActive = true;
  dimOverview();
  if (!wasActive) _enterRouteFocus();

  const idSet    = new Set(ids.map(id => id.toUpperCase()));
  const features = _overviewGeoJson.features.filter(f => idSet.has(f.properties.routeId));

  if (!features.length) { restoreOverview(); return; }

  const fc = { type: 'FeatureCollection', features };

  // Outline layer (added first = rendered underneath)
  _outlineLayer = L.geoJSON(fc, {
    style:    { color: '#111', weight: 7.5, opacity: 0.22, lineCap: 'round', lineJoin: 'round' },
    renderer: _routeCanvas,
    interactive: false,
  }).addTo(_map);

  // Colour layer (added second = rendered on top)
  _routeLayer = L.geoJSON(fc, {
    style:    f => ({ color: featureColor(f.properties), weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }),
    renderer: _routeCanvas,
    interactive: false,
  }).addTo(_map);

  // Endpoint labels — one label per routeId at the start and end of direction-1 geometry
  _stopsLayer = L.layerGroup().addTo(_map);
  const labeled = new Set();
  for (const f of features) {
    const { routeId } = f.properties;
    if (labeled.has(routeId) || String(f.properties.direction) !== '1') continue;
    labeled.add(routeId);

    const coords = f.geometry.coordinates;
    if (!coords.length) continue;
    const endpoints = [coords[0], coords[coords.length - 1]];
    const color     = featureColor(f.properties);

    for (const [lon, lat] of endpoints) {
      const icon = L.divIcon({
        className: '',
        html: `<span class="route-end-label" style="--label-col:${color}">${routeId}</span>`,
        iconSize:   [1, 1],
        iconAnchor: [0, 0],
      });
      L.marker([lat, lon], { icon, interactive: false, keyboard: false }).addTo(_stopsLayer);
    }
  }

  const bounds = _routeLayer.getBounds();
  if (bounds.isValid()) _map.fitBounds(bounds, { padding: [48, 48] });
  if (!_routesVisible) setRoutesVisible(false);
}

export function fitToRoute() {
  if (_routeLayer) {
    const bounds = _routeLayer.getBounds();
    if (bounds.isValid()) _map.fitBounds(bounds, { padding: [48, 48] });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Returns a Map of routeId → properties for all routes currently passing the filter.
 */
export function getVisibleRouteProps() {
  if (!_overviewGeoJson) return new Map();
  const seen = new Map();
  for (const f of _overviewGeoJson.features) {
    if (!featurePassesFilter(f.properties)) continue;
    if (!seen.has(f.properties.routeId)) seen.set(f.properties.routeId, f.properties);
  }
  return seen;
}

/**
 * Show or hide the stops layer. Returns the new visibility state.
 */
export function setStopsVisible(visible) {
  _stopsVisible = visible;
  if (!_stopsLayer) return _stopsVisible;
  if (visible) {
    if (!_map.hasLayer(_stopsLayer)) _stopsLayer.addTo(_map);
  } else {
    if (_map.hasLayer(_stopsLayer)) _map.removeLayer(_stopsLayer);
  }
  return _stopsVisible;
}

/** Call after the sidebar resizes so Leaflet redraws to fill the new container width */
/** Pan + zoom back to the default London landing view. */
export function resetMapView() {
  _map?.flyTo(LONDON, ZOOM, { duration: 0.6 });
}

/**
 * Switch between colouring route lines by type or by operator.
 * Re-applies style to the overview layer and any active single/multi route.
 * The selected route's outbound/inbound colours are deliberately untouched
 * so they always read as two contrasting directions.
 */
export function setPaintMode(mode) {
  _paintMode = mode === 'operator' ? 'operator' : 'type';
  _overviewLayer?.setStyle(f => overviewStyle(f));
  // Multi-route coloured layer recolours per feature. Single-route case keeps
  // its fixed outbound/inbound red/blue because _outlineLayer is null there.
  if (_outlineLayer && _routeLayer) {
    _routeLayer.setStyle(f => ({
      color: featureColor(f.properties),
      weight: 5, opacity: 0.95, lineCap: 'round', lineJoin: 'round',
    }));
  }
  return _paintMode;
}

// ── Garages layer ─────────────────────────────────────────────────────────────

// Operator → short display code + marker colour. Colours sourced from the
// canonical OPERATOR_COLORS palette above so the garage pin reads the same
// hue as the route line, the filter pill dot, and the operator card swatch.
const OPERATOR_META = {
  'Arriva':            { short: 'AR', color: OPERATOR_COLORS['Arriva']            },
  'First':             { short: 'FR', color: OPERATOR_COLORS['First']             },
  'Go-Ahead':          { short: 'GO', color: OPERATOR_COLORS['Go-Ahead']          },
  'Metroline':         { short: 'ML', color: OPERATOR_COLORS['Metroline']         },
  'Stagecoach':        { short: 'SC', color: OPERATOR_COLORS['Stagecoach']        },
  'Stagecoach London': { short: 'SC', color: OPERATOR_COLORS['Stagecoach London'] },
  'Transport UK':      { short: 'TU', color: OPERATOR_COLORS['Transport UK']      },
  'RATP':              { short: 'RP', color: OPERATOR_COLORS['RATP']              },
  'RATP Dev':          { short: 'RP', color: OPERATOR_COLORS['RATP Dev']          },
  'Uno':               { short: 'UN', color: OPERATOR_COLORS['Uno']               },
};
function operatorMeta(name) {
  if (!name) return { short: '??', color: '#475569' };
  if (OPERATOR_META[name]) return OPERATOR_META[name];
  const short = name.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '??';
  return { short, color: '#475569' };
}

// All garage markers tagged with their full record, so we can filter them
// from ui.js and also re-emit the filtered list for CSV/XLSX export.
let _allGarages = []; // [{ marker, garage, routeCount }]

export function renderGarages(garages, garageRoutes = {}) {
  if (_garagesLayer) return; // idempotent: call once at boot
  _garagesLayer = L.layerGroup();
  _allGarages = [];

  // Group garages that share (near-)identical coords so we can fan overlapping
  // markers out in a tiny circle. Two garages at the same building (e.g. Ash
  // Grove = AE Arriva + HK Stagecoach) would otherwise stack and only the top
  // one would be clickable.
  const OFFSET_DEG = 0.00025; // ~18 m — enough to separate pins, not to mislead
  const keyOf = g => `${g.lat.toFixed(5)},${g.lon.toFixed(5)}`;
  const clusters = new Map();
  for (const g of garages) {
    if (g.lat == null || g.lon == null) continue;
    const k = keyOf(g);
    if (!clusters.has(k)) clusters.set(k, []);
    clusters.get(k).push(g);
  }

  for (const g of garages) {
    if (g.lat == null || g.lon == null) continue;

    const cluster = clusters.get(keyOf(g));
    let lat = g.lat, lon = g.lon;
    if (cluster.length > 1) {
      const i = cluster.indexOf(g);
      const angle = (2 * Math.PI * i) / cluster.length - Math.PI / 2; // start north
      lat = g.lat + OFFSET_DEG * Math.sin(angle);
      // Longitude spacing grows with latitude; scale so visual gap is symmetric
      lon = g.lon + OFFSET_DEG * Math.cos(angle) / Math.cos(g.lat * Math.PI / 180);
    }

    const { short, color } = operatorMeta(g.operator);
    const routes   = garageRoutes[g.code] ?? [];
    const count    = routes.length;
    // Garage total PVR comes straight from the source CSV (the PVR field on the
    // garage row is already a garage-wide total). Summing route-level PVRs would
    // also work if each route had its true PVR, but the source data often doesn't.
    const totalPvr = Number.isFinite(g.pvr) ? g.pvr : null;

    // Electrified share: what fraction of the garage's PVR is run by
    // battery-electric routes. Denominator is the sum of route-level PVRs we
    // actually know — the garage-wide CSV total can differ, and mixing the two
    // would produce misleading percentages.
    let evShare = null;
    {
      let knownPvr = 0, electricPvr = 0;
      for (const r of routes) {
        if (!Number.isFinite(r.pvr)) continue;
        knownPvr += r.pvr;
        if (r.propulsion === 'electric') electricPvr += r.pvr;
      }
      if (knownPvr > 0) evShare = Math.round((electricPvr / knownPvr) * 100);
    }

    const marker = L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'garage-marker',
        html: `<span class="garage-marker-pin" style="--garage-col:${color}" title="${g.name} — ${g.operator ?? ''}">
                 <span class="garage-marker-op">${short}</span>
                 ${g.code ? `<span class="garage-marker-code">(${g.code})</span>` : ''}
               </span>`,
        iconSize:   [32, 32],
        iconAnchor: [16, 16],
      }),
      keyboard: false,
    });

    const chipsHtml = routes.length
      ? `<span class="map-popup__routes-hd">Routes operated</span>
         <div class="map-id-popup__chips map-popup__route-chips">${routes.map(r => {
          const col = OPERATOR_COLORS[r.operator] ?? OPERATOR_FALLBACK_COLOR;
          return `<span class="map-id-popup__chip" data-route="${r.routeId}" style="--chip-col:${col}">${r.routeId}</span>`;
        }).join('')}</div>
        <button type="button" class="map-popup__cta" data-garage-view-all>
          <span>View all routes operated here</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
        </button>`
      : '';

    // Operating-centre capacity (DVSA operator licence), shown only when on
    // file for this garage.
    const capacity = Number.isFinite(g.capacity) ? g.capacity : null;
    const capRow = capacity
      ? `<div><dt data-tip="Authorised vehicles at this operating centre. Source: DVSA operator licence. Freshness: curated, updates at licence variation (~yearly).">Capacity</dt><dd>${capacity}</dd></div>`
      : '';

    // Source hovers on every label — mirrors the route-card tooltips. The
    // shared [data-tip] listener in js/tooltip.js is document-level, so it
    // works inside Leaflet popups without extra wiring.
    marker.bindPopup(
      `<span class="map-popup__name">${g.name} <span style="opacity:.55">(${g.code})</span></span>` +
      `<dl class="map-popup__meta">` +
        `<div><dt data-tip="Operator group. Source: londonbusroutes.net. Freshness: as at last weekly refresh.">Operator</dt><dd>${g.operator ?? '–'}</dd></div>` +
        `<div><dt data-tip="Peak Vehicle Requirement (garage total). Source: londonbusroutes.net. Freshness: as at last weekly refresh.">PVR</dt><dd>${totalPvr ?? '–'}</dd></div>` +
        capRow +
        `<div><dt data-tip="Share of the garage's PVR run by battery-electric routes. Source: derived from per-route propulsion. Freshness: refreshed weekly.">Electrification</dt><dd>${evShare == null ? '–' : `${evShare}%`}</dd></div>` +
        `<div><dt data-tip="Number of routes operated from this garage. Source: londonbusroutes.net. Freshness: as at last weekly refresh.">Routes operated</dt><dd>${count}</dd></div>` +
      `</dl>` +
      chipsHtml,
      { closeButton: true, maxWidth: 320 }
    );

    // Wire chip clicks when the popup opens (same pattern as stop-popup chips)
    marker.on('popupopen', () => {
      setTimeout(() => {
        const root = marker.getPopup()?.getElement();
        if (!root) return;
        root.querySelectorAll('.map-id-popup__chip[data-route]').forEach(chip => {
          chip.addEventListener('click', () => {
            marker.closePopup();
            document.dispatchEvent(new CustomEvent('map:routeclick', { detail: chip.dataset.route }));
          });
        });
        // Mirror the drawer "View all routes operated here" CTA — sets the
        // sidebar garage filter so the network narrows to this garage's
        // routes. Same selectedGarages shape + same events as
        // js/stats.js → #dShowRoutes; keeps the popup and drawer in lockstep.
        const cta = root.querySelector('[data-garage-view-all]');
        if (cta) {
          cta.addEventListener('click', () => {
            const routeIds = routes.map(r => r.routeId);
            state.selectedGarages = [{ code: g.code, name: g.name ?? g.code, operator: g.operator ?? null, routeIds }];
            document.dispatchEvent(new CustomEvent('app:garageselected', { detail: state.selectedGarages }));
            document.dispatchEvent(new CustomEvent('app:filterschanged'));
            marker.closePopup();
            highlightGarageByCode(g.code);
          });
        }
      }, 0);
    });

    _garagesLayer.addLayer(marker);
    _allGarages.push({ marker, garage: g, routeCount: count, routeIds: new Set(routes.map(r => r.routeId)) });
  }
}

/**
 * Visually highlight the garage(s) that operate a given route. Passing null
 * clears any active highlight. Used when a single route is focused via search
 * so the user can immediately see where it's based.
 */
export function highlightGaragesForRoute(routeId) {
  if (!_allGarages.length) return;
  for (const entry of _allGarages) {
    const active = routeId != null && entry.routeIds.has(routeId);
    if (active) {
      if (!entry.marker.getTooltip()) {
        entry.marker.bindTooltip('Operating from here', {
          permanent: true,
          direction: 'top',
          offset: [0, -14],
          className: 'garage-route-tooltip',
        });
      }
      entry.marker.openTooltip();
    } else if (entry.marker.getTooltip()) {
      entry.marker.unbindTooltip();
    }
  }
}

/**
 * Show the "Operating from here" tooltip on a single garage by code, clearing
 * any others. Used by the "View all routes operated here" CTA in both the
 * map popup and the drawer — the user filters the network to one garage's
 * routes, so the same visual marker that fires when a single route is focused
 * should fire for the chosen garage. Passing null clears the highlight.
 */
export function highlightGarageByCode(code) {
  if (!_allGarages.length) return;
  for (const entry of _allGarages) {
    const active = code != null && entry.garage.code === code;
    if (active) {
      if (!entry.marker.getTooltip()) {
        entry.marker.bindTooltip('Operating from here', {
          permanent: true,
          direction: 'top',
          offset: [0, -14],
          className: 'garage-route-tooltip',
        });
      }
      entry.marker.openTooltip();
    } else if (entry.marker.getTooltip()) {
      entry.marker.unbindTooltip();
    }
  }
}

/**
 * Filter garage markers by operator. Pass a Set of allowed operator names, or
 * null to show all. Returns the number of garages currently visible.
 * The special value '__unknown__' matches garages with no operator set.
 */
export function filterGarages(operatorSet) {
  if (!_garagesLayer) return 0;
  let visible = 0;
  for (const entry of _allGarages) {
    const op = entry.garage.operator;
    const match = !operatorSet
      || (operatorSet.has('__unknown__') && !op)
      || (op && operatorSet.has(op));
    if (match) {
      if (!_garagesLayer.hasLayer(entry.marker)) _garagesLayer.addLayer(entry.marker);
      visible++;
    } else {
      if (_garagesLayer.hasLayer(entry.marker)) _garagesLayer.removeLayer(entry.marker);
    }
  }
  return visible;
}

export function countVisibleGarages() {
  if (!_allGarages.length) return 0;
  return _garagesLayer
    ? _allGarages.filter(e => _garagesLayer.hasLayer(e.marker)).length
    : _allGarages.length;
}

/** Array of { ...garage, routeCount } for garages currently visible on the map. */
export function getVisibleGarages() {
  if (!_garagesLayer) return [];
  return _allGarages
    .filter(e => _garagesLayer.hasLayer(e.marker))
    .map(e => ({ ...e.garage, routeCount: e.routeCount }));
}

/**
 * Toggle the route-line layers.
 *
 * Behaviour depends on whether a route is currently focused:
 *   • No route selected → hides / shows every route line (full overview).
 *   • Route(s) selected → hides / shows only the *faint context overlay*
 *     (the overview lines behind the focused route). The focused route
 *     itself, its outline, and its stops stay put — the idea is to let
 *     the user switch between "route only" and "route in context" views
 *     without losing the selection.
 *
 * We track two booleans:
 *   • _routesVisible  — actual current overview visibility
 *   • _routesBaseline — user's persisted preference for when no route is focused
 *
 * On route focus we auto-hide the overview (transient); on clear we restore to
 * the baseline. The header toggle still flips visibility during focus but that
 * transient flip doesn't overwrite the user's baseline preference.
 */
let _routesVisible  = true;
let _routesBaseline = true;
let _suppressRoutesTransition = false;

function _applyRoutesVisibility() {
  const layersToToggle = _routeActive
    ? [_overviewLayer]
    : [_overviewLayer, _outlineLayer, _routeLayer, _stopsLayer];
  for (const layer of layersToToggle) {
    if (!layer || !_map) continue;
    if (_routesVisible) { if (!_map.hasLayer(layer)) layer.addTo(_map); }
    else                { if (_map.hasLayer(layer))  _map.removeLayer(layer); }
  }
  if (_routesVisible) _overviewLayer?.bringToBack();
}
function _dispatchRoutesVisibility() {
  document.dispatchEvent(new CustomEvent('map:routesvisibilitychange', { detail: _routesVisible }));
}
function _enterRouteFocus() {
  if (_suppressRoutesTransition) return;
  if (_routesVisible) {
    _routesVisible = false;
    _applyRoutesVisibility();
    _dispatchRoutesVisibility();
  }
}
function _exitRouteFocus() {
  if (_suppressRoutesTransition) return;
  if (_routesVisible !== _routesBaseline) {
    _routesVisible = _routesBaseline;
    _applyRoutesVisibility();
    _dispatchRoutesVisibility();
  }
}

export function setRoutesVisible(visible) {
  _routesVisible = !!visible;
  // A click only updates the persisted baseline when no route is focused;
  // during focus the toggle is transient so baseline is preserved.
  if (!_routeActive) _routesBaseline = _routesVisible;
  _applyRoutesVisibility();
  return _routesVisible;
}

export function isRouteActive() { return _routeActive; }

export function setGaragesVisible(visible) {
  if (!_garagesLayer || !_map) return visible;
  if (visible) {
    if (!_map.hasLayer(_garagesLayer)) _garagesLayer.addTo(_map);
  } else if (_map.hasLayer(_garagesLayer)) {
    _map.removeLayer(_garagesLayer);
  }
  return visible;
}

// ── Global stops preference ───────────────────────────────────────────────────

/** Remember the user's global stops preference so it persists across routes. */
export function setStopsPreference(visible) {
  _stopsPref = !!visible;
  // If a route is currently showing, apply immediately.
  if (_stopsLayer) setStopsVisible(_stopsPref);
  return _stopsPref;
}
