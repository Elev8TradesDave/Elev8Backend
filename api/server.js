/**
 * Elev8Trades Backend (Render-friendly, IPv6-safe)
 * File: api/server.js
 *
 * Features:
 * - /api/health
 * - /api/analyze
 *    • Resolves place (by placeId or name+area)
 *    • Pulls GBP rating & review volume
 *    • Normalizes detailedScores (camelCase 0–100) + detailedScores (labels)
 *    • Optional Gemini merge for on-site/CTA/SEO heuristics (no scraping)
 *    • Returns mapEmbedUrl (uses EMBED key only) + hints.adsEnabled (always false here)
 * - /api/competitive-snapshot (ToS-safe)
 *    • Finds nearby competitors via Places Text Search
 *    • Enriches with details + a photo (Place Photos)
 *    • Adds official links (Google Ads Transparency, Meta Ad Library, Maps, Website)
 * - Serves widget.html/js from repo root for same-origin testing on Render
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client } = require('@googlemaps/google-maps-services-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path'); // <-- needed for static serving

const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

// Keys
const GOOGLE_MAPS_API_KEY_SERVER = process.env.GOOGLE_MAPS_API_KEY_SERVER || '';
const GOOGLE_MAPS_EMBED_API_KEY  = process.env.GOOGLE_MAPS_EMBED_API_KEY || '';
const GEMINI_API_KEY             = process.env.GEMINI_API_KEY || '';

// Scraping flags intentionally disabled (we are NOT scraping)
const ENABLE_AD_SCRAPE = false;
const ENABLE_AD_SCRAPE_IN_PROD = false;

const app = express();
app.set('trust proxy', 1);

// ---------- Middleware ----------
app.use(express.json({ limit: '1mb' }));
app.use(cors({
  origin: [/^http:\/\/localhost:\d+$/, /^https:\/\/.*$/], // tighten to your domains as needed
  methods: ['GET','POST','OPTIONS'],
  credentials: false,
}));
app.use(helmet({
  contentSecurityPolicy: false,       // hosting page sets its own CSP
  crossOriginEmbedderPolicy: false,
}));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ---------- Helpers ----------
const maps = new Client({});

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const asPct   = (x) => Math.round(clamp01(x) * 100);

function reviewVolumeToScore(count) {
  const c = Math.max(0, Number(count) || 0);
  const k = 0.03;   // steepness
  const mid = 40;   // ~50% near 40 reviews
  const max = 500;  // ~100% near 500 reviews
  const s = 1 / (1 + Math.exp(-k * (c - mid)));
  const stretched = Math.min(1, s * (1 + c / max));
  return asPct(stretched);
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

/** Normalize server’s detailed scores and merge optional Gemini numeric scores (0–1 or 0–100). */
function normalizeDetailedScores(raw = {}, geminiScores = {}) {
  const pick = (...keys) => {
    for (const k of keys) if (k in raw && raw[k] != null) return raw[k];
    return 0;
  };
  let norm = {
    overallRating:      pick('overallRating', 'Overall Rating'),
    reviewVolume:       pick('reviewVolume', 'Review Volume'),
    painPointResonance: pick('painPointResonance', 'Pain Point Resonance'),
    ctaStrength:        pick('ctaStrength', 'Call-to-Action Strength', 'cta'),
    websiteHealth:      pick('websiteHealth', 'Website Health'),
    onPageSeo:          pick('onPageSeo', 'On-Page SEO'),
  };
  // Coerce to 0–100 ints
  for (const k of Object.keys(norm)) {
    const v = Number(norm[k]);
    norm[k] = (v <= 1 ? asPct(v) : Math.round(v || 0));
  }
  // Merge Gemini numeric scores if present
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
  const gbp = (norm.overallRating + norm.reviewVolume) / 2; // 0..100
  const site = (norm.painPointResonance + norm.ctaStrength + norm.websiteHealth + norm.onPageSeo) / 4; // 0..100
  const mix = 0.4 * gbp + 0.6 * (Number.isNaN(site) ? 0 : site);
  return Math.round(mix);
}

function buildMapsEmbedUrl(placeId) {
  if (!GOOGLE_MAPS_EMBED_API_KEY || !placeId) return '';
  const base = 'https://www.google.com/maps/embed/v1/place';
  return `${base}?key=${encodeURIComponent(GOOGLE_MAPS_EMBED_API_KEY)}&q=place_id:${encodeURIComponent(placeId)}`;
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

  const queryParts = [];
  if (businessName) queryParts.push(businessName);
  if (serviceArea) queryParts.push(serviceArea);
  const input = queryParts.join(' ').trim();
  if (!input) {
    return { placeId: null, candidates: [], clarifications: [{ type: 'missing', field: 'businessName/serviceArea' }] };
  }

  const resp = await maps.findPlaceFromText({
    params: {
      key: GOOGLE_MAPS_API_KEY_SERVER,
      input,
      inputtype: 'textquery',
      fields: ['place_id', 'name', 'formatted_address', 'website'],
    },
    timeout: 8000,
  });

  const results = (resp.data && resp.data.candidates) || [];
  if (!results.length) {
    return { placeId: null, candidates: [], clarifications: [{ type: 'no_match', message: 'No matches found. Try adding city/state.' }] };
  }

  // Domain match if website is provided
  const inputDomain = websiteUrl ? normDomain(websiteUrl) : '';
  let chosen = null;
  if (inputDomain) {
    chosen = results.find(r => r.website && normDomain(r.website) === inputDomain) || null;
  }
  if (!chosen && results.length === 1) {
    chosen = results[0];
  }
  if (!chosen) {
    const candidates = results.slice(0, 6).map(r => ({
      name: r.name,
      address: r.formatted_address,
      placeId: r.place_id,
      website: r.website || '',
    }));
    return { placeId: null, candidates, clarifications: [{ type: 'multiple', message: 'Multiple matches found. Select one.' }] };
  }

  return { placeId: chosen.place_id, candidates: [], clarifications: [] };
}

// ---------- Gemini (optional; no scraping) ----------
async function runGeminiAnalysis({ homepageText, reviewSnippets, timeoutMs = 12000 }) {
  if (!GEMINI_API_KEY) return null;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const prompt = `
You are a local SEO analyzer. Using ONLY the website copy and reviews provided,
estimate these 0–100 scores (integers) and a topPriority string:

- painPointResonance
- ctaStrength
- websiteHealth
- onPageSeo

Return strict JSON ONLY:
{"scores":{"painPointResonance":<0-100>,"ctaStrength":<0-100>,"websiteHealth":<0-100>,"onPageSeo":<0-100>},"topPriority":"...","reviewSentiment":"..."}

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
    const jsonStr = txt.replace(/^[\s`]+|[\s`]+$/g, '');
    try {
      const parsed = JSON.parse(jsonStr);
      const out = {
        scores: parsed?.scores || {},
        topPriority: parsed?.topPriority || '',
        reviewSentiment: parsed?.reviewSentiment || '',
      };
      // Coerce numbers safely
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

// (Placeholders: extend later if you want robots-aware fetching)
async function fetchHomepageText(/* url */) { return ''; }
async function fetchReviewSnippets(/* placeId */) { return ''; }

// ---------- Routes ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    adsEnabled: false,
  });
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

    // 1) Resolve place
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

    // 2) GBP core signals
    const details = await maps.placeDetails({
      params: {
        key: GOOGLE_MAPS_API_KEY_SERVER,
        place_id: pid,
        fields: ['name','formatted_address','rating','user_ratings_total','website'],
      },
      timeout: 8000,
    }).catch(() => ({ data: {} }));

    const rating = Number(details?.data?.result?.rating || 0);              // 0..5
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

    // 3) Optional Gemini (no scraping; uses placeholders for now)
    let gemini = null;
    if (useGemini && GEMINI_API_KEY && !fast) {
      const homepageText = websiteUrl ? await fetchHomepageText(websiteUrl) : '';
      const reviewSnips  = await fetchReviewSnippets(pid);
      gemini = await runGeminiAnalysis({ homepageText, reviewSnippets: reviewSnips, timeoutMs: 12000 });
    }

    // 4) Normalize + final score
    const { norm, display } = normalizeDetailedScores(baseScoresDisplay, gemini?.scores);
    const finalScore = blendedFinalScore(norm);

    // 5) Output
    return res.json({
      success: true,
      finalScore,
      detailedScores: display,           // labels (back-compat)
      detailedScoresCamel: norm,         // camelCase (preferred)
      geminiAnalysis: {
        scores: gemini?.scores || {},
        topPriority: gemini?.topPriority || '',
        competitorAdAnalysis: '',        // no scraping, so leave empty
        reviewSentiment: gemini?.reviewSentiment || '',
      },
      topCompetitor: null,
      mapEmbedUrl: buildMapsEmbedUrl(pid),
      placeId: pid,
      clarifications: [],
      hints: { adsEnabled: false },
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

/**
 * Competitive Snapshot (ToS-safe)
 * Finds nearby competitors via Google Places, enriches with details & a photo,
 * provides official ad-transparency links. No scraping.
 */
app.post('/api/competitive-snapshot', async (req, res) => {
  try {
    const {
      placeId,
      businessType = 'contractor',
      serviceArea = '',
      limit = 5,
      useGemini = false, // off by default here; you can turn on later
    } = req.body || {};

    if (!GOOGLE_MAPS_API_KEY_SERVER) {
      return res.json({ success: false, error: 'Missing GOOGLE_MAPS_API_KEY_SERVER' });
    }

    // 1) Bias to target place location if provided
    let bias = null;
    if (placeId) {
      const det = await maps.placeDetails({
        params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: placeId, fields: ['geometry'] },
        timeout: 8000,
      }).catch(() => ({ data: {} }));
      const loc = det?.data?.result?.geometry?.location;
      if (loc?.lat && loc?.lng) bias = { lat: loc.lat, lng: loc.lng };
    }

    // 2) Find competitors
    const query = `${businessType}${serviceArea ? ' in ' + serviceArea : ''}`;
    const tsParams = bias
      ? { key: GOOGLE_MAPS_API_KEY_SERVER, query, location: bias, radius: 15000 }
      : { key: GOOGLE_MAPS_API_KEY_SERVER, query };

    const ts = await maps.textSearch({ params: tsParams, timeout: 8000 });
    const raw = (ts.data?.results || []).filter(r => r.place_id !== placeId);

    const ranked = raw
      .map(r => ({ ...r, __score: (Number(r.rating || 0)) * (Number(r.user_ratings_total || 0)) }))
      .sort((a,b) => b.__score - a.__score)
      .slice(0, limit);

    // 3) Enrich
    const items = [];
    for (const r of ranked) {
      const pid = r.place_id;
      const det = await maps.placeDetails({
        params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: pid, fields: ['name','formatted_address','rating','user_ratings_total','website','photos'] },
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
      const googleAdsT = `https://ads.transparency.google.com/advertiser?hl=en&search=${encName}`;
      const metaLib   = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&search_type=keyword_unordered&media_type=all&search=${encName}`;

      items.push({
        placeId: pid,
        name,
        address,
        rating,
        reviews,
        website: d.website || '',
        photoUrl,
        links: {
          googleAdsTransparency: googleAdsT,
          metaAdLibrary: metaLib,
          googleMaps: `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(pid)}`
        },
        inferredThemes: [],
        counters: [],
        reviewSentiment: ''
      });
    }

    res.json({ success: true, competitors: items });
  } catch (e) {
    console.error('competitive-snapshot error', e);
    res.json({ success: false, error: 'competitive-snapshot failed' });
  }
});

// ---------- Static widget serving (same-origin) ----------
app.use('/', express.static(path.join(__dirname, '..')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'widget.html'));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`[elev8] listening on :${PORT} (${NODE_ENV}) — adsEnabled=${ENABLE_AD_SCRAPE && (IS_PROD ? ENABLE_AD_SCRAPE_IN_PROD : true)}`);
});

module.exports = app;
