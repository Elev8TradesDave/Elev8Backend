/* widget.js — Elev8Trades Local Visibility Audit (IDs aligned to widget.html) */

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const clamp = (n,min=0,max=100)=>Math.max(min,Math.min(max,Number(n)||0));
async function post(url, body){
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body||{})
  });
  try { return await r.json(); } catch { return { success:false, error:`HTTP ${r.status}` }; }
}

/* ---------- DOM refs (match your HTML) ---------- */
const nameInput   = $('#bName');
const urlInput    = $('#webUrl');
const areaInput   = $('#area');
const tradeSelect = $('#tradeSelect');
const fastInput   = $('#fast');

const btnAnalyze      = $('#btnAnalyze');
const btnCompetitors  = $('#btnCompetitors');
const btnTop          = $('#btnTop');

const overallPct = $('#overallPct');
const overallBar = $('#overallBar');

const s_overall = $('#s_overall');
const s_reviews = $('#s_reviews');
const s_pain    = $('#s_pain');
const s_cta     = $('#s_cta');
const s_web     = $('#s_web');
const s_onpage  = $('#s_onpage');

const mapWrap  = $('#mapEmbedWrap');
const mapFrame = $('#mapEmbed');

const competitorsBox = $('#competitorsBox');

/* ---------- state ---------- */
let lastPlaceId = null;

/* ---------- UI helpers ---------- */
function setBusy(b){ document.documentElement.classList.toggle('is-busy', !!b); }
function resetScores(){
  overallPct.textContent = '—';
  overallBar.style.width = '0%';
  s_overall.textContent = '—';
  s_reviews.textContent = '—';
  s_pain.textContent    = '—';
  s_cta.textContent     = '—';
  s_web.textContent     = '—';
  s_onpage.textContent  = '—';
}
function put(valEl, barEl, v){
  const n = clamp(v);
  if (valEl) valEl.textContent = n;
  if (barEl) barEl.style.width = n + '%';
}
function readTrade(){
  const v = (tradeSelect?.value || '').trim();
  return v || 'general';
}

/* ---------- ANALYZE ---------- */
async function analyze(){
  resetScores(); setBusy(true);
  try{
    const payload = {
      businessName: (nameInput?.value || '').trim(),
      websiteUrl:   (urlInput?.value   || '').trim(),
      serviceArea:  (areaInput?.value  || '').trim(),
      businessType: readTrade(),
      fast: !!(fastInput && fastInput.checked),
      useGemini: true
    };

    const data = await post('/api/analyze', payload);
    console.log('[analyze]', data);

    if (!data?.success){
      overallPct.textContent = 'Error';
      return;
    }

    lastPlaceId = data.placeId || null;

    // overall
    const final = clamp(data.finalScore || 0);
    overallPct.textContent = final + '%';
    overallBar.style.width = final + '%';

    // signals (labels come from server as human-readable keys)
    const ds = data.detailedScores || {};
    put(s_overall,  null, ds['Overall Rating'] ?? 0);
    put(s_reviews,  null, ds['Review Volume'] ?? 0);
    put(s_pain,     null, ds['Pain Point Resonance'] ?? 0);
    put(s_cta,      null, ds['Call-to-Action Strength'] ?? 0);
    put(s_web,      null, ds['Website Health'] ?? 0);
    put(s_onpage,   null, ds['On-Page SEO'] ?? 0);

    // map
    if (data.mapEmbedUrl){
      if (mapFrame) mapFrame.src = data.mapEmbedUrl;
      if (mapWrap)  mapWrap.style.display = '';
    }

    // auto-pull competitors after a successful analyze
    await fetchCompetitors({
      placeId: lastPlaceId,
      businessType: readTrade(),
      serviceArea: (areaInput?.value || '').trim()
    });

    // if we couldn't resolve place but got candidates, surface that hint
    if (!lastPlaceId && Array.isArray(data?.clarifications) && data.clarifications.length){
      console.warn('Clarifications from API:', data.clarifications);
    }

  } catch(err){
    console.error(err);
    overallPct.textContent = 'Error';
  } finally{
    setBusy(false);
  }
}

/* ---------- COMPETITORS ---------- */
function compCardHTML(c){
  const stars = (Number(c.rating||0)).toFixed(1);
  const revs  = Number(c.reviews||0);
  const img   = c.photoUrl ? `<img src="${c.photoUrl}" alt="${c.name}" loading="lazy">` : `<div style="height:160px;background:#0d0f12"></div>`;
  const links = `
    <div class="links">
      <a class="link-btn" href="${c.links.googleAdsTransparency}" target="_blank" rel="noopener">Google Ads</a>
      <a class="link-btn" href="${c.links.metaAdLibrary}" target="_blank" rel="noopener">Meta Ads</a>
      <a class="link-btn" href="${c.links.googleMaps}" target="_blank" rel="noopener">Maps</a>
      ${c.website ? `<a class="link-btn" href="${c.website}" target="_blank" rel="noopener">Website</a>` : ''}
    </div>`;
  return `
    <article class="comp-card">
      ${img}
      <div class="comp-body">
        <div style="font-weight:700">${c.name}</div>
        <div style="color:#a9b3ad;font-size:13px">${c.address||''}</div>
        <div style="margin-top:6px">⭐ ${stars} · ${revs} reviews</div>
        ${links}
      </div>
    </article>`;
}

async function fetchCompetitors({ placeId, businessType, serviceArea }){
  setBusy(true);
  try{
    if (competitorsBox) competitorsBox.innerHTML = `<div style="color:#a9b3ad">Loading competitors…</div>`;
    const body = {
      placeId: placeId || undefined,
      businessType: (businessType || readTrade()),
      serviceArea: (serviceArea || areaInput?.value || '').trim(),
      limit: 6,
      useGemini: false
    };
    const json = await post('/api/competitive-snapshot', body);
    console.log('[competitive-snapshot]', json);

    if (!json?.success){
      competitorsBox.innerHTML = `<div style="color:#a9b3ad">Couldn’t load competitors.</div>`;
      return;
    }
    const list = Array.isArray(json.competitors) ? json.competitors : [];
    if (!list.length){
      competitorsBox.innerHTML = `<div style="color:#a9b3ad">No trade-matched competitors found. Try a nearby city or broader service area.</div>`;
      return;
    }
    competitorsBox.innerHTML = list.map(compCardHTML).join('');
  } catch(e){
    console.error(e);
    competitorsBox.innerHTML = `<div style="color:#a9b3ad">Error loading competitors.</div>`;
  } finally{
    setBusy(false);
  }
}

/* ---------- wire up ---------- */
btnAnalyze?.addEventListener('click', e => { e.preventDefault(); analyze(); });
btnCompetitors?.addEventListener('click', e => {
  e.preventDefault();
  fetchCompetitors({
    placeId: lastPlaceId,
    businessType: readTrade(),
    serviceArea: (areaInput?.value || '').trim()
  });
});
btnTop?.addEventListener('click', e => {
  e.preventDefault();
  fetchCompetitors({
    placeId: lastPlaceId, // still bias to your business if we have it
    businessType: readTrade(),
    serviceArea: (areaInput?.value || '').trim()
  });
});

/* Optional: create a favicon link to avoid console noise if you didn’t ship one */
(function ensureFavicon(){
  if (!document.querySelector('link[rel="icon"]')) {
    const l = document.createElement('link');
    l.rel = 'icon'; l.href = '/favicon.ico';
    document.head.appendChild(l);
  }
})();
