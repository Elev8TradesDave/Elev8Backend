/**
 * server.js — Elev8Trades Analysis API (hardened)
 * - Places search (+fallback), review snippets
 * - Optional Google Ads Transparency scrape (Puppeteer) behind flag
 * - Gemini JSON output parsing (defensive)
 * - Reverse geocoding endpoint (Maps SDK-correct)
 * - Timeouts, input validation, CORS/Helmet/Rate-limit
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Client } = require('@googlemaps/google-maps-services-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ENABLE_AD_SCRAPE = /^true$/i.test(process.env.ENABLE_AD_SCRAPE || 'false');

// Required envs
if (!MAPS_KEY) throw new Error('Missing GOOGLE_MAPS_API_KEY');
if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');

// ---------- APP ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(
  cors({
    origin: [
      /elev8trades\.com$/,
      /links\.elev8trades\.com$/,
      /go\.highlevel\.com$/,
      /app\.highlevel\.com$/,
    ],
  })
);
app.use(express.json({ limit: '200kb' }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

// ---------- CLIENTS ----------
const mapsClient = new Client({});
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

// ---------- UTILS ----------
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const isHttpUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
};

// Reusable Puppeteer (optional)
const PUP_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
let sharedBrowserPromise;
async function getBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer.launch({ headless: 'new', args: PUP_ARGS });
  }
  return sharedBrowserPromise;
}

async function scrapeGoogleAds(domain) {
  if (!ENABLE_AD_SCRAPE) return [];
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (compatible; Elev8Engine/1.0)');
    await page.goto('https://adstransparency.google.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('input[placeholder="Advertiser name, topic or website"]', { timeout: 6000 });
    await page.type('input[placeholder="Advertiser name, topic or website"]', domain);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-test-id="ad-creative-card"]', { timeout: 8000 });
    const ads = await page.$$eval('[data-test-id="ad-creative-card"]', nodes =>
      nodes.slice(0, 3).map(n => n.innerText || '')
    );
    return ads;
  } catch (e) {
    console.log(`Ad scrape skipped for ${domain}: ${e.message}`);
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ---------- ENDPOINT: Reverse Geocode ----------
app.get('/reverse', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Latitude and longitude are required.' });
  try {
    const { data } = await mapsClient.reverseGeocode(
      {
        params: {
          latlng: { lat: Number(lat), lng: Number(lon) },
          result_type: ['locality', 'political'],
          key: MAPS_KEY,
        },
        timeout: 5000,
      }
    );
    const result = (data.results || [])[0];
    if (!result) return res.status(404).json({ error: 'Could not find city for coordinates.' });

    let city = '', state = '';
    for (const c of result.address_components) {
      if (c.types.includes('locality')) city = c.long_name;
      if (c.types.includes('administrative_area_level_1')) state = c.short_name;
    }
    return res.json({ cityState: [city, state].filter(Boolean).join(', ') });
  } catch (e) {
    console.error('Reverse geocode error:', e.message);
    return res.status(500).json({ error: 'Failed to reverse geocode.' });
  }
});

// ---------- MAIN: Analyze ----------
app.post('/analyze', async (req, res) => {
  const start = Date.now();
  const { businessName, websiteUrl, businessType, serviceArea } = req.body || {};

  // Basic validation
  if (!businessName || !websiteUrl || !businessType) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  if (!isHttpUrl(websiteUrl)) {
    return res.status(400).json({ success: false, message: 'Invalid websiteUrl' });
  }
  if (!['specialty', 'maintenance'].includes(businessType)) {
    return res.status(400).json({ success: false, message: 'Invalid businessType' });
  }

  const effectiveServiceArea = (serviceArea || '').toString().trim();
  const primaryQuery = effectiveServiceArea ? `${businessName} ${effectiveServiceArea}` : businessName;
  const fallbackQuery = `${businessName} contractor`;

  try {
    // 1) Places search (+fallback)
    let placesResponse = await mapsClient.textSearch(
      { params: { query: primaryQuery, key: MAPS_KEY }, timeout: 6000 }
    );
    let allResults = placesResponse.data.results || [];
    if (allResults.length === 0) {
      placesResponse = await mapsClient.textSearch(
        { params: { query: fallbackQuery, key: MAPS_KEY }, timeout: 6000 }
      );
      allResults = placesResponse.data.results || [];
    }

    // If no Places data, return a safe baseline with map embed on the query
    if (allResults.length === 0) {
      return res.status(200).json({
        success: true,
        finalScore: 70,
        detailedScores: {
          'Overall Rating': 60,
          'Review Volume': 40,
          'Pain Point Resonance': 50,
          'Call-to-Action Strength': 50,
          'Website Health': 50,
          'On-Page SEO': 50,
        },
        geminiAnalysis: {
          scores: {},
          topPriority: 'Add your primary NJ town and trade into the H1 and title tag.',
          competitorAdAnalysis: 'No competitor detected for this query.',
          reviewSentiment: 'Not enough public reviews to summarize.',
        },
        topCompetitor: null,
        mapEmbedUrl: `https://www.google.com/maps/embed/v1/search?key=${MAPS_KEY}&q=${encodeURIComponent(primaryQuery)}`,
      });
    }

    const userBusiness = allResults[0];
    const topCompetitor = allResults.find(r => r.place_id !== userBusiness.place_id) || null;

    // 2) Details for user business (rating, review count, a few review snippets)
    const detailsForUser = await mapsClient.placeDetails(
      {
        params: {
          place_id: userBusiness.place_id,
          fields: ['name', 'rating', 'user_ratings_total', 'reviews'],
          key: MAPS_KEY,
        },
        timeout: 6000,
      }
    );
    const userDetails = detailsForUser.data.result || {};
    const googleData = {
      rating: userDetails.rating || 4.0,
      reviewCount: userDetails.user_ratings_total || 0,
    };
    const reviewSnippets = (userDetails.reviews || []).slice(0, 5).map(r => r.text || '');

    // 3) Competitor website + optional Ads Transparency scrape
    let topCompetitorData = null;
    let competitorAds = [];
    if (topCompetitor) {
      try {
        const competitorDetails = await mapsClient.placeDetails(
          {
            params: { place_id: topCompetitor.place_id, fields: ['name', 'website'], key: MAPS_KEY },
            timeout: 6000,
          }
        );
        const comp = competitorDetails.data.result || {};
        if (comp.website) {
          topCompetitorData = { name: comp.name || topCompetitor.name, website: comp.website };
          const domain = new URL(comp.website).hostname;
          competitorAds = await scrapeGoogleAds(domain);
        } else {
          topCompetitorData = { name: comp.name || topCompetitor.name, website: null };
        }
      } catch (e) {
        console.log('Competitor details scrape skipped:', e.message);
      }
    }

    // 4) Map embed URL
    const searchQuery =
      effectiveServiceArea && effectiveServiceArea.length
        ? `${businessName} ${effectiveServiceArea}`
        : `${businessName}`;
    const mapEmbedUrl = `https://www.google.com/maps/embed/v1/search?key=${MAPS_KEY}&q=${encodeURIComponent(
      searchQuery
    )}`;

    // 5) Gemini analysis (defensive JSON parse)
    const geminiPrompt = `
Analyze a local contractor:
- Business: "${businessName}"
- Market: "${effectiveServiceArea || 'unknown'}"
- Model: "${businessType}"
- Website: "${websiteUrl}"

Recent public review snippets (up to 5):
${JSON.stringify(reviewSnippets)}

Top competitor: "${topCompetitorData?.name || 'unknown'}"
Competitor ads (first 3, if any): ${JSON.stringify(competitorAds)}

Return ONLY a JSON object with keys:
{
  "scores": {
    "painPointResonance": 0-100,
    "ctaStrength": 0-100,
    "websiteHealth": 0-100,
    "onPageSEO": 0-100
  },
  "topPriority": "<single most actionable next step tailored for the market>",
  "competitorAdAnalysis": "<themes/offers from their ads or a suggested angle>",
  "reviewSentiment": "<biggest positive theme inferred from the review snippets>"
}
    `.trim();

    const gen = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: geminiPrompt }]}],
      generationConfig: { maxOutputTokens: 1024 },
    });

    let raw = gen.response.text() || '';
    const match = raw.match(/\{[\s\S]*\}$/);
    if (!match) throw new Error('Gemini did not return JSON.');
    let geminiAnalysis = JSON.parse(match[0]);

    // 6) Scoring
    const { finalScore, detailedScores } = calculateFinalScore(
      googleData,
      geminiAnalysis.scores || {},
      businessType
    );

    // 7) Respond
    console.log(`Analyze done in ${Date.now() - start}ms for "${businessName}"`);
    return res.json({
      success: true,
      finalScore,
      detailedScores,
      geminiAnalysis,
      topCompetitor: topCompetitorData,
      mapEmbedUrl,
    });
  } catch (error) {
    console.error('Full analysis error:', error);
    return res.status(500).json({ success: false, message: 'An error occurred during the analysis.' });
  }
});

// ---------- SCORING ----------
function calculateFinalScore(googleData, geminiScores, businessType) {
  const ratingScore = clampPct((Number(googleData.rating || 0) / 5) * 100);
  const reviewScore = clampPct(Math.min((Number(googleData.reviewCount || 0) / 150), 1) * 100);

  const allScores = {
    rating: ratingScore,
    reviewVolume: reviewScore,
    painPointResonance: clampPct(geminiScores.painPointResonance),
    ctaStrength: clampPct(geminiScores.ctaStrength),
    websiteHealth: clampPct(geminiScores.websiteHealth),
    onPageSEO: clampPct(geminiScores.onPageSEO),
  };

  let final;
  if (businessType === 'specialty') {
    final = Math.round(
      allScores.rating * 0.20 +
      allScores.reviewVolume * 0.15 +
      allScores.painPointResonance * 0.20 +
      allScores.ctaStrength * 0.05 +
      allScores.websiteHealth * 0.15 +
      allScores.onPageSEO * 0.15
    );
  } else {
    // maintenance / service-based
    final = Math.round(
      allScores.rating * 0.15 +
      allScores.reviewVolume * 0.15 +
      allScores.painPointResonance * 0.05 +
      allScores.ctaStrength * 0.25 +
      allScores.websiteHealth * 0.15 +
      allScores.onPageSEO * 0.15
    );
  }

  return {
    finalScore: Math.min(final || 70, 99),
    detailedScores: {
      'Overall Rating': allScores.rating,
      'Review Volume': allScores.reviewVolume,
      'Pain Point Resonance': allScores.painPointResonance,
      'Call-to-Action Strength': allScores.ctaStrength,
      'Website Health': allScores.websiteHealth,
      'On-Page SEO': allScores.onPageSEO,
    },
  };
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Analysis server running on port ${PORT} (ads scrape: ${ENABLE_AD_SCRAPE ? 'on' : 'off'})`);
});
