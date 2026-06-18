/**
 * about.js — About modal, injected on load so any page with an #about-btn
 * (topbar, footer, mobile-nav) opens the same dialog. Included by index.html
 * and changelog.html.
 */

(function () {
  const MODAL_HTML = `
    <div id="about-modal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div class="modal-backdrop" data-close></div>
      <div class="modal-panel">
        <button class="modal-close" aria-label="Close" data-close>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>

        <div class="modal-header">
          <div class="modal-brand" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.8" fill="none"/>
              <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="modal-heading">
            <h2 id="about-title" class="modal-title">London Buses</h2>
            <span class="modal-subtitle">Every route on one map</span>
          </div>
        </div>

        <p class="modal-lede">An interactive map of every London bus route — search, filter by operator, garage, route type, propulsion, and more. <strong>Not a journey planner</strong> — for live times and travel advice, use <a href="https://tfl.gov.uk/plan-a-journey/" target="_blank" rel="noopener">tfl.gov.uk</a>.</p>

        <div class="modal-disclaimer" role="note">
          <strong>Disclaimer.</strong> This site is an independent project and is <strong>not affiliated with, endorsed by, or operated by Transport for London (TfL), London Buses, or any bus operator</strong>. Data is compiled from public sources and may be incomplete, out of date, or inaccurate. You are responsible for verifying anything before acting on it; I take no responsibility for how this information is used.
        </div>

        <section class="modal-section">
          <span class="modal-section-tag">Privacy</span>
          <p class="modal-note" style="margin-top: 0; padding: 0 var(--sp-3);">
            Aggregate page-view stats only via <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google Analytics</a>. No accounts, no personal data, no advertising cookies.
          </p>
        </section>

        <section class="modal-section">
          <span class="modal-section-tag">Developer</span>
          <ul class="credits-list credits-list--inline">
            <li><a href="https://farhan.app" target="_blank" rel="noopener">Farhan Munim</a><span class="credits-note">farhan.app</span></li>
          </ul>
        </section>

        <section class="modal-section">
          <span class="modal-section-tag">Contributors</span>
          <p class="modal-note" style="margin-top: 0; padding: 0 var(--sp-3);">Daniel Plumb, Mark Leonard-Adoko, Ross Levine, Paul Tran</p>
        </section>

        <section class="modal-section modal-support">
          <span class="modal-section-tag">Support</span>
          <p class="modal-support__copy">
            Support the development of this project.
          </p>
          <a class="modal-support__link" href="https://buymeacoffee.com/farhan.app" target="_blank" rel="noopener">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M7 3v2M10 3v2M13 3v2"/></svg>
            Buy me a coffee
            <svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>
          </a>
        </section>
      </div>
    </div>
  `;

  function ensureModal() {
    let modal = document.getElementById('about-modal');
    if (modal) return modal;
    const wrap = document.createElement('div');
    wrap.innerHTML = MODAL_HTML.trim();
    modal = wrap.firstElementChild;
    document.body.appendChild(modal);
    return modal;
  }

  // Focusable elements inside the modal, in tab order
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let lastTrigger = null;

  function getFocusable(modal) { return [...modal.querySelectorAll(FOCUSABLE)].filter(el => !el.hidden); }

  function open(trigger) {
    const modal = ensureModal();
    lastTrigger = trigger ?? document.activeElement;
    modal.hidden = false;
    // Move focus into the dialog — prefer the close button for predictable tabbing
    const closeBtn = modal.querySelector('.modal-close');
    (closeBtn ?? getFocusable(modal)[0])?.focus();
  }
  function close() {
    const m = document.getElementById('about-modal');
    if (!m || m.hidden) return;
    m.hidden = true;
    // Restore focus to whatever opened the dialog
    lastTrigger?.focus?.();
    lastTrigger = null;
  }

  function trapFocus(e) {
    const modal = document.getElementById('about-modal');
    if (!modal || modal.hidden || e.key !== 'Tab') return;
    const items = getFocusable(modal);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last)  { e.preventDefault(); first.focus(); }
  }

  function init() {
    // Any #about-btn (topbar, footer, mobile-nav) opens the dialog
    document.addEventListener('click', e => {
      const btn = e.target.closest('#about-btn');
      if (btn) { e.preventDefault(); open(btn); return; }
      const closer = e.target.closest('#about-modal [data-close]');
      if (closer) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const m = document.getElementById('about-modal');
        if (m && !m.hidden) close();
      } else {
        trapFocus(e);
      }
    });
    // Pre-inject the modal so the first open is immediate
    ensureModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
