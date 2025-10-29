// ---------- CONFIG ----------
const hostProvided = (window.API_BASE || '').trim();
const API_BASE = hostProvided; // '' => same-origin (e.g., '/api/analyze')
const apiBaseTextEl = document.getElementById('apiBaseText');
if (apiBaseTextEl) apiBaseTextEl.textContent = API_BASE ? API_BASE : 'same-origin';

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const bName = el('businessName');
const webUrl = el('websiteUrl');
const area   = el('serviceArea');
const fast   = el('fast');

const overallPct = el('overallPct');
const overallBar = el('overallBar');

const labels = [
  { bar: el('bar1'), txt: el('sc1'), key: ['overallRating', 'Overall Rating'] },
  { bar: el('bar2'), txt: el('sc2'), key: ['reviewVolume', 'Review Volume'] },
  { bar: el('bar3'), txt: el('sc3'), key: ['painPointResonance', 'Pain Point Resonance'] },
  { bar: el('bar4'), txt: el('sc4'), key: ['ctaStrength', 'Call-to-Action Strength'] },
  { bar: el('bar5'), txt: el('sc5'), key: ['websiteHealth', 'Website Health'] },
  { bar: el('bar6'), txt: el('sc6'), key: ['onPageSeo', 'On-Page SEO'] },
];

const nextStep = el('nextStep');
const adThemes = el('adThemes');
const revSent  = el('revSent');
const mapFrame = el('mapFrame');

const competitorsBox = el('competitors');
const showCompetitorsBtn = el('showCompetitors');

// Track last placeId from /analyze (helps bias competitor search)
let LAST_PLACE_ID = null;

// ---------- UI helpers ----------
function clamp(x, lo=0, hi=100) { return Math.max(lo, Math.min(hi, x|0)); }
function updateBar(barEl, pct) { barEl.style.width = clamp(pct) + '%'; }
function setBusy(b){ el('analyzeBtn').disabled = !!b; if (showCompetitorsBtn) showCompetitorsBtn.disabled = !!b; }

// ---------- API helpers ----------
function url(path) {
  // If API_BASE is '', we use same-origin like '/api/analyze'
  return `${API_BASE}${path}`;
}

async function post(path, body) {
  const res = await fetch(url(path), {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  });
  return await res.json();
}

// ---------- Analyze flow ----------
function resetScoresUI() {
  overallPct.textContent = '—'; updateBar(overallBar, 0);
  labels.forEach(({ bar, txt }) => { txt.textContent = '—'; updateBar(bar, 0); });
  nextStep.textContent = '—'; adThemes.textContent = '—'; revSent.textContent = '—';
  mapFrame.src = '';
}

function readBizType() {
  return document.querySelector('input[name="biztype"]:checked')?.value || 'contractor';
}

function getScoreValue(data, camelKey, labelKey) {
  // Prefer camelCase if server sent detailedScoresCamel; else fall back to label map.
  const camel = data.detailedScoresCamel || {};
  const label = data.detailedScores || {};
  if (camelKey in camel) return camel[camelKey];
  if (labelKey in label) return label[labelKey];
  return 0;
}

async function analyze(extra = {}) {
  resetScoresUI(); setBusy(true);
  try {
    const payload = {
      businessName: bName.value.trim(),
      websiteUrl:   webUrl.value.trim(),
      serviceArea:  area.value.trim(),
      businessType: readBizType(),
      fast: !!fast.checked,
      useGemini: true,
      ...extra,
    };

    const data = await post('/api/analyze', payload);
    console.log('analyze response', data);

    if (!data?.success) {
      overallPct.textContent = 'Error'; return;
    }

    LAST_PLACE_ID = data.placeId || LAST_PLACE_ID || null;

    // Overall
    const final = clamp(Number(data.finalScore) || 0);
    overallPct.textContent = final + '%';
    updateBar(overallBar, final);

    // Metrics
    for (const { bar, txt, key } of labels) {
      const v = clamp(Number(getScoreValue(data, key[0], key[1])) || 0);
      txt.textContent = v + '%';
      updateBar(bar, v);
    }

    // AI bits
    nextStep.textContent = data?.geminiAnalysis?.topPriority || '—';
    adThemes.textContent = data?.geminiAnalysis?.competitorAdAnalysis || 'Use competitor cards below to view official ad libraries.';
    revSent.textContent  = data?.geminiAnalysis?.reviewSentiment || '—';

    // Map
    if (data?.mapEmbedUrl) mapFrame.src = data.mapEmbedUrl;
  } finally {
    setBusy(false);
  }
}

document.getElementById('analyzeBtn').addEventListener('click', () => analyze());

// ---------- Competitors ----------
function compCard(c) {
  const rating = (typeof c.rating === 'number' && c.rating >= 0) ? c.rating.toFixed(1) : '—';
  return `
  <div class="card">
    ${c.photoUrl ? `<img class="thumb" src="${c.photoUrl}" alt="${c.name}">` : ''}
    <div style="margin-top:10px;">
      <div style="font-weight:700">${c.name}</div>
      <div class="muted">${c.address || ''}</div>
      <div class="row-compact">⭐ ${rating} · ${c.reviews ?? 0} reviews</div>
      ${Array.isArray(c.inferredThemes) && c.inferredThemes.length ? `<div class="row-compact"><strong>Themes:</strong> ${c.inferredThemes.join(', ')}</div>` : ''}
      ${Array.isArray(c.counters) && c.counters.length ? `<div class="row-compact"><strong>Counter-angles:</strong> ${c.counters.join('; ')}</div>` : ''}
      ${c.reviewSentiment ? `<div class="row-compact"><strong>Reviews:</strong> ${c.reviewSentiment}</div>` : ''}
      <div class="inline" style="margin-top:8px; flex-wrap: wrap; gap:8px;">
        <a class="btn-link" href="${c.links.googleAdsTransparency}" target="_blank" rel="noopener">Google Ads</a>
        <a class="btn-link" href="${c.links.metaAdLibrary}" target="_blank" rel="noopener">Meta Ads</a>
        <a class="btn-link" href="${c.links.googleMaps}" target="_blank" rel="noopener">Maps</a>
        ${c.website ? `<a class="btn-link" href="${c.website}" target="_blank" rel="noopener">Website</a>` : ''}
      </div>
    </div>
  </div>`;
}

async function fetchCompetitors() {
  competitorsBox.innerHTML = '<div class="muted">Finding nearby competitors…</div>';
  setBusy(true);
  try {
    const body = {
      placeId: LAST_PLACE_ID || undefined,
      businessType: readBizType(),
      serviceArea: area.value.trim(),
      useGemini: false  // keep ToS-safe; enable if you add robots-aware site/review text later
    };
    const json = await post('/api/competitive-snapshot', body);
    console.log('competitive-snapshot', json);

    if (!json?.success) {
      competitorsBox.innerHTML = '<div class="muted">Could not load competitors.</div>';
      return;
    }
    if (!Array.isArray(json.competitors) || !json.competitors.length) {
      competitorsBox.innerHTML = '<div class="muted">No competitors found for this area.</div>';
      return;
    }
    competitorsBox.innerHTML = json.competitors.map(compCard).join('');
  } finally {
    setBusy(false);
  }
}
showCompetitorsBtn.addEventListener('click', fetchCompetitors);

// ---------- Optional: auto-bias competitor search after analyze ----------
window.addEventListener('load', () => {
  // For demos you could auto-run analyze() here.
});
