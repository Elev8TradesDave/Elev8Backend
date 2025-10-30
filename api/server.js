/**
 * Elev8Trades Backend (Render-friendly, IPv6-safe)
 * File: api/server.js
 *
 * Endpoints:
 * - GET  /api/health
 * - POST /api/analyze
 * - POST /api/competitive-snapshot
 *
 * Notes:
 * - Uses Google Maps Places API (no scraping).
 * - Resolves place by ID or name+area (findPlaceFromText), then enriches with placeDetails.
 * - IMPORTANT: findPlaceFromText does NOT request "website" (unsupported); website is fetched via placeDetails.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client } = require('@googlemaps/google-maps-services-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Env var names (match Render)
const GOOGLE_MAPS_API_KEY_SERVER = process.env.GOOGLE_MAPS_API_KEY_SERVER || '';
const GOOGLE_MAPS_EMBED_KEY      = process.env.GOOGLE_MAPS_EMBED_KEY || '';
const GEMINI_API_KEY             = process.env.GEMINI_API_KEY || '';

// Ad scrape is intentionally disabled
const ENABLE_AD_SCRAPE = false;
const ENABLE_AD_SCRAPE_IN_PROD = false;

const app = express();
app.set('trust proxy', 1);

// ---------- Middleware ----------
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: [/^http:\/\/localhost:\d+$/i, /^https:\/\/.*$/i],
  methods: ['GET','POST','OPTIONS'],
  credentials: false
}));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
}));

// Quiet favicon noise in DevTools
app.get('/favicon.ico', (_req, res) => res.sendStatus(204));

// ---------- Helpers ----------
const maps = new Client({});
const clamp01 = x => Math.max(0, Math.min(1, Number(x) || 0));
const asPct   = x => Math.round(clamp01(x) * 100);

function reviewVolumeToScore(count) {
  const c = Math.max(0, Number(count) || 0);
  const k = 0.03, mid = 40, max = 500;
  const s = 1 / (1 + Math.exp(-k * (c - mid)));
  return asPct(Math.min(1, s * (1 + c / max)));
}

function toDisplayScores(norm) {
  return {
    'Overall Rating': norm.overallRating,
    'Review Volume': norm.reviewVolume,
    'Pain Point Resonance': norm.painPointResonance,
    'Call-to-Action Strength': norm.ctaStrength,
    'Website Health': norm.websiteHealth,
    'On-Page SEO': norm.onPageSeo,
  };
}

function normalizeDetailedScores(raw = {}, geminiScores = {}) {
  const pick = (...keys) => { for (const k of keys) if (k in raw && raw[k] != null) return raw[k]; return 0; };
  let norm = {
    overallRating:      pick('overallRating', 'Overall Rating'),
    reviewVolume:       pick('reviewVolume', 'Review Volume'),
    painPointResonance: pick('painPointResonance', 'Pain Point Resonance'),
    ctaStrength:        pick('ctaStrength', 'Call-to-Action Strength', 'cta'),
    websiteHealth:      pick('websiteHealth', 'Website Health'),
    onPageSeo:          pick('onPageSeo', 'On-Page SEO'),
  };
  for (const k of Object.keys(norm)) {
    const v = Number(norm[k]);
    norm[k] = (v <= 1 ? asPct(v) : Math.round(v || 0));
  }
  const gs = geminiScores || {};
  const mergeNum = (key, alt) => {
    const v = gs[key] ?? gs[alt];
    if (v == null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    norm[key] = n <= 1 ? asPct(n) : Math.max(0, Math.min(100, Math.round(n)));
  };
  mergeNum('painPointResonance', 'pain_point_resonance');
  mergeNum('ctaStrength', 'cta_strength');
  mergeNum('websiteHealth', 'website_health');
  mergeNum('onPageSeo', 'on_page_seo');

  return { norm, display: toDisplayScores(norm) };
}

function blendedFinalScore(norm) {
  const gbp  = (norm.overallRating + norm.reviewVolume) / 2;
  const site = (norm.painPointResonance + norm.ctaStrength + norm.websiteHealth + norm.onPageSeo) / 4;
  const mix  = 0.4 * gbp + 0.6 * (Number.isNaN(site) ? 0 : site);
  return Math.round(mix);
}

function buildMapsEmbedUrl(placeId) {
  if (!GOOGLE_MAPS_EMBED_KEY || !placeId) return '';
  const base = 'https://www.google.com/maps/embed/v1/place';
  return `${base}?key=${encodeURIComponent(GOOGLE_MAPS_EMBED_KEY)}&q=place_id:${encodeURIComponent(placeId)}`;
}

function normDomain(u) {
  try {
    const url = new URL(u.startsWith('http') ? u : `https://${u}`);
    return url.hostname.replace(/^www\./, '');
  } catch { return ''; }
}

// ---------- Place resolution ----------
async function resolvePlaceId({ placeId, businessName, websiteUrl, serviceArea }) {
  if (!GOOGLE_MAPS_API_KEY_SERVER) throw new Error('Missing GOOGLE_MAPS_API_KEY_SERVER');
  if (placeId) return { placeId, candidates: [], clarifications: [] };

  const parts = [];
  if (businessName) parts.push(businessName);
  if (serviceArea)  parts.push(serviceArea);
  const input = parts.join(' ').trim();
  if (!input) {
    return { placeId: null, candidates: [], clarifications: [{ type: 'missing', field: 'businessName/serviceArea' }] };
  }

  // DO NOT request "website" here; it's unsupported and causes 400.
  const resp = await maps.findPlaceFromText({
    params: {
      key: GOOGLE_MAPS_API_KEY_SERVER,
      input,
      inputtype: 'textquery',
      fields: ['place_id', 'name', 'formatted_address'],
    },
    timeout: 8000,
  });

  const results = (resp.data && resp.data.candidates) || [];
  if (!results.length) {
    return { placeId: null, candidates: [], clarifications: [{ type: 'no_match', message: 'No matches found. Try adding city/state.' }] };
  }

  // Try to pick by domain (requires placeDetails below)
  const inputDomain = websiteUrl ? normDomain(websiteUrl) : '';
  let chosen = null;

  // If only one, use it
  if (!chosen && results.length === 1) chosen = results[0];

  // If multiple and we have a site, look each up for website and match domain
  if (!chosen && inputDomain) {
    for (const r of results.slice(0, 6)) {
      const det = await maps.placeDetails({
        params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: r.place_id, fields: ['website'] },
        timeout: 8000,
      }).catch(() => ({ data: {} }));
      const site = det?.data?.result?.website || '';
      if (site && normDomain(site) === inputDomain) { chosen = r; break; }
    }
  }

  if (!chosen) {
    // Return light candidate list; UI can render a selector if you want later
    const candidates = await Promise.all(results.slice(0, 6).map(async r => {
      const det = await maps.placeDetails({
        params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: r.place_id, fields: ['website'] },
        timeout: 8000,
      }).catch(() => ({ data: {} }));
      return {
        name: r.name,
        address: r.formatted_address,
        placeId: r.place_id,
        website: det?.data?.result?.website || '',
      };
    }));
    return { placeId: null, candidates, clarifications: [{ type: 'multiple', message: 'Multiple matches found. Select one.' }] };
  }

  return { placeId: chosen.place_id, candidates: [], clarifications: [] };
}

// ---------- Gemini (optional; no scraping here) ----------
async function runGeminiAnalysis({ homepageText, reviewSnippets, timeoutMs = 12000 }) {
  if (!GEMINI_API_KEY) return null;
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const prompt = `
Return JSON only with numeric (0–100) scores and short notes.

{"scores":{"painPointResonance":0,"ctaStrength":0,"websiteHealth":0,"onPageSeo":0},"topPriority":"","reviewSentiment":""}

Website copy:
${(homepageText || '').slice(0, 5000)}

Reviews:
${(reviewSnippets || '').slice(0, 3000)}
`.trim();

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }]}] });
    clearTimeout(to);
    const txt = resp?.response?.text?.() || '';
    if (!txt) return null;
    try {
      const parsed = JSON.parse(txt.replace(/^[\s`]+|[\s`]+$/g, ''));
      const out = {
        scores: parsed?.scores || {},
        topPriority: parsed?.topPriority || '',
        reviewSentiment: parsed?.reviewSentiment || '',
      };
      for (const k of ['painPointResonance','ctaStrength','websiteHealth','onPageSeo']) {
        const v = Number(out.scores[k]);
        if (Number.isFinite(v)) out.scores[k] = v <= 1 ? asPct(v) : Math.max(0, Math.min(100, Math.round(v)));
        else delete out.scores[k];
      }
      return out;
    } catch {
      return { scores: {}, topPriority: '', reviewSentiment: '' };
    }
  } catch {
    clearTimeout(to);
    return null;
  }
}

// Placeholders (safe; add fetching later if desired)
async function fetchHomepageText(){ return ''; }
async function fetchReviewSnippets(){ return ''; }

// ---------- Trade mapping for competitor search ----------
const TRADE_TO_PLACES = {
  roofing:        { type: 'roofing_contractor', keywords: ['roofing', 'roof repair', 'roof replacement'] },
  siding:         { type: 'contractor',         keywords: ['siding contractor', 'siding installation'] },
  roofing_siding: { type: 'contractor',         keywords: ['roofing contractor', 'siding contractor'] },
  hvac:           { type: 'hvac_contractor',    keywords: ['hvac', 'ac repair', 'heating', 'air conditioning'] },
  plumbing:       { type: 'plumber',            keywords: ['plumber', 'drain', 'water heater'] },
  electrical:     { type: 'electrician',        keywords: ['electrician', 'electrical contractor'] },
  landscaping:    { type: 'landscaper',         keywords: ['landscaping', 'lawn care'] },
  masonry:        { type: 'contractor',         keywords: ['masonry', 'brick', 'stone', 'block'] },
  concrete:       { type: 'contractor',         keywords: ['concrete contractor', 'concrete'] },
  general:        { type: 'general_contractor', keywords: ['general contractor', 'home improvement'] },
  solar:          { type: 'contractor',         keywords: ['solar company', 'solar installer'] },
  garage_doors:   { type: 'contractor',         keywords: ['garage door repair', 'garage door installation'] },
  fencing:        { type: 'contractor',         keywords: ['fence contractor', 'fencing'] },
  paving:         { type: 'contractor',         keywords: ['asphalt paving', 'driveway paving', 'paving contractor'] },
  windows:        { type: 'contractor',         keywords: ['window replacement', 'door installation', 'windows and doors'] },
  painting:       { type: 'painter',            keywords: ['house painter', 'painting contractor'] },
};
const normalizeTrade = t => (TRADE_TO_PLACES[String(t||'').toLowerCase()] ? String(t).toLowerCase() : 'general');

// ---------- Routes ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, env: NODE_ENV, adsEnabled: false });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const {
      placeId,
      businessName,
      websiteUrl,
      serviceArea,
      businessType,
      fast = false,
      useGemini = true,
    } = req.body || {};

    const resolved = await resolvePlaceId({ placeId, businessName, websiteUrl, serviceArea });
    if (!resolved.placeId) {
      return res.json({
        success: true,
        finalScore: 0,
        detailedScores: {
          'Overall Rating': 0,
          'Review Volume': 0,
          'Pain Point Resonance': 0,
          'Call-to-Action Strength': 0,
          'Website Health': 0,
          'On-Page SEO': 0,
        },
        detailedScoresCamel: {
          overallRating: 0, reviewVolume: 0, painPointResonance: 0, ctaStrength: 0, websiteHealth: 0, onPageSeo: 0
        },
        geminiAnalysis: { scores: {}, topPriority: '', competitorAdAnalysis: '', reviewSentiment: '' },
        topCompetitor: null,
        mapEmbedUrl: '',
        placeId: null,
        clarifications: [{ candidates: resolved.candidates }, ...resolved.clarifications],
        hints: { adsEnabled: false },
      });
    }

    const pid = resolved.placeId;

    // Enrich with details (includes website, rating, review count)
    const details = await maps.placeDetails({
      params: {
        key: GOOGLE_MAPS_API_KEY_SERVER,
        place_id: pid,
        fields: ['name','formatted_address','rating','user_ratings_total','website'],
      },
      timeout: 8000,
    }).catch(() => ({ data: {} }));

    const rating  = Number(details?.data?.result?.rating || 0);              // 0..5
    const reviews = Number(details?.data?.result?.user_ratings_total || 0); // count
    const overallRatingPct = asPct(rating / 5);
    const reviewVolumePct  = reviewVolumeToScore(reviews);

    const baseScoresDisplay = {
      'Overall Rating': overallRatingPct,
      'Review Volume': reviewVolumePct,
      'Pain Point Resonance': 0,
      'Call-to-Action Strength': 0,
      'Website Health': 0,
      'On-Page SEO': 0,
    };

    // Optional Gemini (kept safe: no scraping here)
    let gemini = null;
    if (useGemini && GEMINI_API_KEY && !fast) {
      const homepageText = websiteUrl ? await fetchHomepageText(websiteUrl) : '';
      const reviewSnips  = await fetchReviewSnippets(pid);
      gemini = await runGeminiAnalysis({ homepageText, reviewSnippets: reviewSnips, timeoutMs: 12000 });
    }

    const { norm, display } = normalizeDetailedScores(baseScoresDisplay, gemini?.scores);
    const finalScore = blendedFinalScore(norm);

    return res.json({
      success: true,
      finalScore,
      detailedScores: display,
      detailedScoresCamel: norm,
      geminiAnalysis: {
        scores: gemini?.scores || {},
        topPriority: gemini?.topPriority || '',
        competitorAdAnalysis: '',
        reviewSentiment: gemini?.reviewSentiment || '',
      },
      topCompetitor: null,
      mapEmbedUrl: buildMapsEmbedUrl(pid),
      placeId: pid,
      clarifications: [],
      hints: { adsEnabled: false },
      _debug: { businessType: businessType || '' }
    });
  } catch (err) {
    console.error('analyze error', err);
    res.status(200).json({
      success: false,
      error: 'Analysis failed, but request handled gracefully.',
      hints: { adsEnabled: false },
    });
  }
});

/** Trade-aware competitor snapshot using Places Text Search (ToS-safe) */
app.post('/api/competitive-snapshot', async (req, res) => {
  try {
    let {
      placeId,
      businessType = 'general',
      serviceArea = '',
      limit = 6,
    } = req.body || {};

    if (!GOOGLE_MAPS_API_KEY_SERVER) {
      return res.json({ success: false, error: 'Missing GOOGLE_MAPS_API_KEY_SERVER' });
    }

    const tradeKey = normalizeTrade(businessType);
    const tradeCfg = TRADE_TO_PLACES[tradeKey];

    // 1) Bias search near the target business if we have its geometry
    let bias = null;
    if (placeId) {
      const det = await maps.placeDetails({
        params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: placeId, fields: ['geometry'] },
        timeout: 8000,
      }).catch(() => ({ data: {} }));
      const loc = det?.data?.result?.geometry?.location;
      if (loc?.lat && loc?.lng) bias = { lat: loc.lat, lng: loc.lng };
    }

    // 2) Build Text Search query
    const queryBits = [];
    if (tradeCfg?.keywords?.length) queryBits.push(tradeCfg.keywords[0]);
    if (serviceArea) queryBits.push(`in ${serviceArea}`);
    const query = queryBits.join(' ').trim() || 'contractor';

    const tsParams = bias
      ? { key: GOOGLE_MAPS_API_KEY_SERVER, query, location: bias, radius: 20000 }
      : { key: GOOGLE_MAPS_API_KEY_SERVER, query };

    if (tradeCfg?.type) tsParams.type = tradeCfg.type;

    const ts = await maps.textSearch({ params: tsParams, timeout: 8000 });
    const raw = (ts.data?.results || []).filter(r => r.place_id !== placeId);

    // 3) Light post-filter by trade keywords
    const kw = (tradeCfg?.keywords || []).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const rx = kw ? new RegExp(kw, 'i') : null;
    const filtered = rx ? raw.filter(r => rx.test(`${r.name} ${r.types?.join(' ') || ''}`)) : raw;

    const ranked = filtered
      .map(r => ({ ...r, __score: (Number(r.rating || 0)) * (Number(r.user_ratings_total || 0)) }))
      .sort((a,b) => b.__score - a.__score)
      .slice(0, limit);

    // 4) Enrich each result
    const items = [];
    for (const r of ranked) {
      const pid = r.place_id;
      const det = await maps.placeDetails({
        params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: pid, fields: ['name','formatted_address','rating','user_ratings_total','website','photos','types'] },
        timeout: 8000,
      }).catch(() => ({ data: {} }));

      const d = det?.data?.result || {};
      const name = d.name || r.name || 'Unknown';
      const address = d.formatted_address || r.formatted_address || '';
      const rating = Number(d.rating || r.rating || 0);
      const reviews = Number(d.user_ratings_total || r.user_ratings_total || 0);

      let photoUrl = '';
      const ref = d.photos?.[0]?.photo_reference;
      if (ref && GOOGLE_MAPS_API_KEY_SERVER) {
        photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${encodeURIComponent(ref)}&key=${encodeURIComponent(GOOGLE_MAPS_API_KEY_SERVER)}`;
      }

      const encName = encodeURIComponent(name);
      items.push({
        placeId: pid,
        name,
        address,
        rating,
        reviews,
        website: d.website || '',
        photoUrl,
        types: d.types || [],
        links: {
          googleAdsTransparency: `https://ads.transparency.google.com/advertiser?hl=en&search=${encName}`,
          metaAdLibrary: `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&search_type=keyword_unordered&media_type=all&search=${encName}`,
          googleMaps: `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(pid)}`
        },
        inferredThemes: [],
        counters: [],
        reviewSentiment: ''
      });
    }

    res.json({ success: true, competitors: items, _trade: tradeKey });
  } catch (e) {
    console.error('competitive-snapshot error', e);
    res.json({ success: false, error: 'competitive-snapshot failed' });
  }
});

// ---------- Static widget (for same-origin testing on Render) ----------
app.use('/', express.static(path.join(__dirname, '..')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'widget.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[elev8] listening on :${PORT} (${NODE_ENV}) — adsEnabled=${ENABLE_AD_SCRAPE && (IS_PROD ? ENABLE_AD_SCRAPE_IN_PROD : true)}`);
});

module.exports = app;
