/**
 * roadmap.js — Roadmap modal, injected on load so any #roadmap-btn on any
 * page opens the same dialog. Mirrors the About modal pattern.
 *
 * Features are defined as a plain array so a roadmap update is a one-line edit.
 */

(function () {
  // Each entry: { title, desc, stage, notes?, link? }
  // Stages: 'idea' | 'planned' | 'building' | 'shipped'
  const ITEMS = [
    { title: 'Route tender details',
      desc:  'Previous operator, contract value and next-tender date on every route card.',
      stage: 'shipped' },
    { title: 'Analytics',
      desc:  'Charts and trends across the network — fleet age, electrification, operator share, fleet capacity and more.',
      stage: 'building' },
    { title: 'Map detail levels',
      desc:  'Show more road and label detail on the basemap, especially on larger screens.',
      stage: 'shipped' },
    { title: 'Postcode search',
      desc:  'Centre the map on any London postcode and list nearby routes.',
      stage: 'idea' },
    { title: 'Saved views',
      desc:  'Bookmark a filter + paint-mode combination as a shareable link.',
      stage: 'idea' },
    { title: 'Headway integration',
      desc:  'Link to {link} for richer operational insights.',
      link:  { href: 'https://headway.plumby.io/', label: 'headway.plumby.io' },
      stage: 'idea' },
  ];

  const STAGE_LABEL = {
    idea:     'Idea',
    planned:  'Planned',
    building: 'In development',
    shipped:  'Shipped',
  };

  function rowHtml({ title, desc, stage, link, notes }) {
    const label = STAGE_LABEL[stage] ?? stage;
    // desc is HTML-escaped so it's safe, but we then splice in a safely-built
    // <a> wherever the string contains the `{link}` placeholder. This lets a
    // description embed an inline link without giving items raw HTML access.
    const linkHtml = link
      ? `<a class="roadmap__link" href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)} ↗</a>`
      : '';
    const descHtml = desc ? escapeHtml(desc).replace('{link}', linkHtml) : '';
    const notesHtml = Array.isArray(notes) && notes.length
      ? `<ul class="roadmap__notes">${notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
      : '';
    return `
      <tr>
        <td class="roadmap__title">${escapeHtml(title)}</td>
        <td class="roadmap__desc">${descHtml}${notesHtml}</td>
        <td class="roadmap__stage-cell"><span class="roadmap__stage roadmap__stage--${stage}">${label}</span></td>
      </tr>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const MODAL_HTML = `
    <div id="roadmap-modal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="roadmap-title">
      <div class="modal-backdrop" data-close></div>
      <div class="modal-panel modal-panel--wide">
        <button class="modal-close" aria-label="Close" data-close>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>

        <div class="modal-header">
          <div class="modal-brand" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M2 4h12M2 8h12M2 12h8" fill="none"/>
            </svg>
          </div>
          <div class="modal-heading">
            <h2 id="roadmap-title" class="modal-title">Roadmap</h2>
            <span class="modal-subtitle">What's next for London Buses</span>
          </div>
        </div>

        <p class="modal-lede">
          A running list of ideas and commitments. Stages move left-to-right as features progress.
          Shipped features are mirrored in the <a href="changelog.html">changelog</a>.
        </p>

        <table class="roadmap">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Description</th>
              <th scope="col">Stage</th>
            </tr>
          </thead>
          <tbody>
            ${ITEMS.map(rowHtml).join('')}
          </tbody>
        </table>

        <p class="modal-note">
          Have a suggestion? Get in touch via
          <a href="https://farhan.app" target="_blank" rel="noopener">farhan.app</a>.
        </p>

        <section class="modal-section modal-support">
          <span class="modal-section-tag">Support</span>
          <p class="modal-support__copy">
            Help move ideas from this list into the changelog.
          </p>
          <a class="modal-support__link" href="https://buymeacoffee.com/farhan.app" target="_blank" rel="noopener">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h13v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M7 3v2M10 3v2M13 3v2"/></svg>
            Buy me a coffee
            <svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>
          </a>
        </section>
      </div>
    </div>`;

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let lastTrigger = null;

  function ensureModal() {
    let modal = document.getElementById('roadmap-modal');
    if (modal) return modal;
    const wrap = document.createElement('div');
    wrap.innerHTML = MODAL_HTML.trim();
    modal = wrap.firstElementChild;
    document.body.appendChild(modal);
    return modal;
  }
  function focusable(modal) { return [...modal.querySelectorAll(FOCUSABLE)].filter(el => !el.hidden); }

  function open(trigger) {
    const modal = ensureModal();
    lastTrigger = trigger ?? document.activeElement;
    modal.hidden = false;
    (modal.querySelector('.modal-close') ?? focusable(modal)[0])?.focus();
  }
  function close() {
    const m = document.getElementById('roadmap-modal');
    if (!m || m.hidden) return;
    m.hidden = true;
    lastTrigger?.focus?.();
    lastTrigger = null;
  }

  function trapFocus(e) {
    const modal = document.getElementById('roadmap-modal');
    if (!modal || modal.hidden || e.key !== 'Tab') return;
    const items = focusable(modal);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last)  { e.preventDefault(); first.focus(); }
  }

  function init() {
    document.addEventListener('click', e => {
      // Any #roadmap-btn OR element with [data-roadmap-open] triggers the dialog
      const btn = e.target.closest('#roadmap-btn, [data-roadmap-open]');
      if (btn) { e.preventDefault(); open(btn); return; }
      const closer = e.target.closest('#roadmap-modal [data-close]');
      if (closer) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const m = document.getElementById('roadmap-modal');
        if (m && !m.hidden) close();
      } else {
        trapFocus(e);
      }
    });
    ensureModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
