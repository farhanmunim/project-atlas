/**
 * tooltip.js — One shared, custom-styled tooltip used by any element with a
 * `data-tip` attribute. Replaces the browser's native `title` tooltip so we
 * control timing and look. A single tooltip element is appended to <body>;
 * it floats above any overflow:hidden ancestors via position:fixed.
 *
 * Behaviour:
 *   - Hovering a [data-tip] element shows the tip text after ~120 ms (so
 *     mousing across the card doesn't strobe tooltips).
 *   - The tip auto-positions above the target, centred horizontally; if
 *     there isn't enough room above (rare), it flips below.
 *   - Tapping a [data-tip] element shows the tip until the next outside
 *     tap — basic touch fallback.
 */

const SHOW_DELAY_MS = 120;

let tipEl = null;
let showTimer = null;
let currentTarget = null;

function ensureTipEl() {
  if (tipEl) return tipEl;
  tipEl = document.createElement('div');
  tipEl.className = 'app-tooltip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tipEl);
  return tipEl;
}

function position(target) {
  const tip = ensureTipEl();
  const r   = target.getBoundingClientRect();
  // Measure tooltip after content is set
  tip.style.left = '-9999px';
  tip.style.top  = '-9999px';
  tip.style.display = 'block';
  const tr = tip.getBoundingClientRect();
  const margin = 6;

  // Default: above, centred
  let top  = r.top - tr.height - margin;
  let flip = false;
  if (top < 4) { top = r.bottom + margin; flip = true; }

  // Centre horizontally on the target, but clamp to viewport
  let left = r.left + (r.width - tr.width) / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));

  tip.style.top  = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
  tip.classList.toggle('app-tooltip--below', flip);
}

function show(target) {
  const text = target.dataset.tip;
  if (!text) return;
  const tip = ensureTipEl();
  tip.textContent = text;
  position(target);
  tip.classList.add('is-visible');
  currentTarget = target;
}

function hide() {
  clearTimeout(showTimer);
  showTimer = null;
  if (!tipEl) return;
  tipEl.classList.remove('is-visible');
  tipEl.style.display = 'none';
  currentTarget = null;
}

function init() {
  document.addEventListener('mouseover', e => {
    const target = e.target.closest('[data-tip]');
    if (!target || target === currentTarget) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(target), SHOW_DELAY_MS);
  });

  document.addEventListener('mouseout', e => {
    const target = e.target.closest('[data-tip]');
    if (!target) return;
    // Only hide when leaving the same element we showed for.
    const next = e.relatedTarget?.closest?.('[data-tip]');
    if (next === target) return;
    hide();
  });

  // Touch fallback — tap to show, tap outside to hide.
  document.addEventListener('click', e => {
    const target = e.target.closest('[data-tip]');
    if (target) { show(target); return; }
    if (currentTarget) hide();
  }, true);

  // Hide on scroll / resize so the tip never floats away from its anchor.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
