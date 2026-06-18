/*
 * Garage-capacity extraction bookmarklet
 * =====================================
 *
 * The DVSA operator-licensing web service is Imperva/Incapsula bot-walled —
 * fetch, headless Puppeteer and headful Puppeteer all get HTTP 403. The only
 * thing that passes is a real human browser. So instead of scraping it
 * server-side (impossible) or screenshotting (slow, OCR-error-prone), this
 * bookmarklet runs INSIDE your normal browser on a licence page and copies
 * the operating-centre table to your clipboard as clean JSON.
 *
 * ── One-time setup ─────────────────────────────────────────────────────────
 *   1. Create a new browser bookmark, name it "Grab OC capacity".
 *   2. Paste the MINIFIED one-liner at the bottom of this file as its URL.
 *
 * ── Each refresh (~yearly; capacity rarely changes) ────────────────────────
 *   1. Go to vehicle-operator-licensing.service.gov.uk and search each London
 *      bus operator (by a known garage postcode) → open its licence page
 *      (/view-details/licence/<id>). There are ~14 PSV licences.
 *   2. Click the bookmark. It copies one JSON object to your clipboard and
 *      shows a confirmation alert.
 *   3. Paste each into capacity/licences.json under "licences": [ ... ].
 *   4. Run:  npm run build-garage-capacity   (matches OCs → garages)
 *            npm run build-garage-locations  (surfaces on the frontend)
 *   5. Commit data/garage-capacity.json + data/garage-locations.json.
 *
 * The readable source is below; the deployable one-liner is at the very end.
 */

(function () {
  const id = (location.pathname.match(/licence\/(\d+)/) || [])[1] || null;
  const operator = (document.querySelector('h1')?.innerText || '').trim();

  // Find the table whose header mentions "Operating centre" + "Vehicles".
  let table = null;
  for (const t of document.querySelectorAll('table')) {
    const head = t.querySelector('tr')?.innerText.toLowerCase() || '';
    if (head.includes('operating centre') && head.includes('vehicles')) { table = t; break; }
  }
  if (!table) { alert('No operating-centre table found on this page.'); return; }

  const ocs = [];
  for (const tr of table.querySelectorAll('tr')) {
    const cells = [...tr.querySelectorAll('td')].map(c => c.innerText.trim());
    if (cells.length < 2) continue;                 // skip header / spacers
    const vehicles = parseInt(cells[1].replace(/[^\d]/g, ''), 10);
    if (!cells[0] || !Number.isFinite(vehicles)) continue;
    ocs.push({ address: cells[0].replace(/\s+/g, ' '), vehicles });
  }

  // Licence total (the "Total Number of vehicles" under Authorisation).
  let total = null;
  const bodyText = document.body.innerText;
  const m = bodyText.match(/Total Number of vehicles\s*([\d,]+)/i);
  if (m) total = parseInt(m[1].replace(/,/g, ''), 10);

  const out = { id, operator, name: operator, total, ocs };
  const json = JSON.stringify(out, null, 2);
  navigator.clipboard.writeText(json)
    .then(() => alert(`Copied ${ocs.length} operating centres for "${operator}" (licence ${id}) to clipboard.`))
    .catch(() => { console.log(json); alert('Clipboard blocked — JSON logged to console instead.'); });
})();

/*
 * ── Minified bookmarklet (paste this whole line as the bookmark URL) ───────
 *
javascript:(function(){var id=(location.pathname.match(/licence\/(\d+)/)||[])[1]||null,operator=(document.querySelector('h1')?.innerText||'').trim(),table=null;for(var t of document.querySelectorAll('table')){var h=(t.querySelector('tr')?.innerText||'').toLowerCase();if(h.includes('operating centre')&&h.includes('vehicles')){table=t;break;}}if(!table){alert('No operating-centre table found.');return;}var ocs=[];for(var tr of table.querySelectorAll('tr')){var c=[...tr.querySelectorAll('td')].map(function(x){return x.innerText.trim();});if(c.length<2)continue;var v=parseInt(c[1].replace(/[^\d]/g,''),10);if(!c[0]||!Number.isFinite(v))continue;ocs.push({address:c[0].replace(/\s+/g,' '),vehicles:v});}var tot=null,m=document.body.innerText.match(/Total Number of vehicles\s*([\d,]+)/i);if(m)tot=parseInt(m[1].replace(/,/g,''),10);var o={id:id,operator:operator,name:operator,total:tot,ocs:ocs},j=JSON.stringify(o,null,2);navigator.clipboard.writeText(j).then(function(){alert('Copied '+ocs.length+' OCs for "'+operator+'" (licence '+id+').');}).catch(function(){console.log(j);alert('Clipboard blocked — JSON in console.');});})();
 *
 */
