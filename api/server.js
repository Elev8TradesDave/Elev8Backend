/**
 * Elev8Trades Backend (Render-friendly, IPv6-safe)
 * File: api/server.js
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Client } = require("@googlemaps/google-maps-services-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");

// ---------- CONFIG ----------
const PORT = process.env.PORT || 10000; // Render binds automatically; 10000 is fine locally
const ENABLE_AD_SCRAPE = /^true$/i.test(process.env.ENABLE_AD_SCRAPE || "false");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Keys (split)
const MAPS_SERVER = process.env.GOOGLE_MAPS_API_KEY || "";   // server: Places, Geocoding
const MAPS_EMBED  = process.env.GOOGLE_MAPS_EMBED_KEY || ""; // browser: Maps Embed (referrer-restricted)

// ---------- APP ----------
const app = express();
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          "data:",
          "https://*.ggpht.com",
          "https://*.googleapis.com",
          "https://*.googleusercontent.com",
          "https://*.gstatic.com"
        ],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", "https://www.google.com", "https://*.google.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(cors());
app.use(express.json({ limit: "200kb" }));
app.use(express.static(path.join(__dirname, "..")));

// ---------- RATE LIMIT (IPv6-safe key) ----------
const ipFromReq = (req) => {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const fwd = req.headers["forwarded"];
  if (typeof fwd === "string") {
    const m = fwd.match(/for="?([^;"]+)/i);
    if (m && m[1]) return m[1].replace(/^"|"$/g, "");
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
};

app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipFromReq,
    validate: false,
    skipFailedRequests: true
  })
);

// Stop browsers from hitting the server for icons
app.use("/favicon.ico", (_req, res) => res.status(204).end());
app.use("/favicon.png", (_req, res) => res.status(204).end());

// ---------- SERVE WIDGET ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "widget.html"));
});
app.get("/widget.html", (_req, res) => {
  res.type("text/html").sendFile(path.join(__dirname, "..", "widget.html"));
});
app.get("/widget.js", (_req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "..", "widget.js"));
});

// ---------- HEALTH ----------
const healthHandler = (_req, res) =>
  res.json({
    ok: true,
    mapsKeyPresent: Boolean(MAPS_SERVER),
    embedKeyPresent: Boolean(MAPS_EMBED),
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    env: process.env.NODE_ENV || "unknown"
  });

app.get("/api/health", healthHandler);
app.get("/health", healthHandler);

// ---------- ENV CHECK ----------
function requireEnv(keys, res) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing env:", missing.join(", "));
    res.status(500).json({ success: false, error: `Server configuration missing: ${missing.join(", ")}` });
    return true;
  }
  return false;
}

// ---------- CLIENTS ----------
const mapsClient = new Client({});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
// FIX: Use v1 model name that exists
const model = process.env.GEMINI_API_KEY
  ? genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" })
  : null;

// ---------- UTILS ----------
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const normalizeHost = (h) => (h || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*/, "");
const looksLikeDomain = (s="") => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);

const isHttpUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
};

const withTimeout = (p, ms, label = "timeout") =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label)), ms))]);

const buildMapEmbedUrl = (qOrPlaceId) =>
  MAPS_EMBED
    ? `https://www.google.com/maps/embed/v1/place?key=${MAPS_EMBED}&q=${
        String(qOrPlaceId).startsWith("place_id:") ? qOrPlaceId : encodeURIComponent(qOrPlaceId || "Business")
      }`
    : null;

const errPayload = (e) => {
  const status = e?.response?.status;
  const data = e?.response?.data;
  const dataStr =
    typeof data === "string"
      ? data.slice(0, 300)
      : data
      ? JSON.stringify(data).slice(0, 300)
      : undefined;
  return { msg: e?.message, status, data: dataStr };
};

// ---------- AREA CLASSIFICATION + RADIUS ----------
const US_STATES = new Set([
  "alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware",
  "district of columbia","dc","florida","georgia","hawaii","idaho","illinois","indiana","iowa",
  "kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota",
  "mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey",
  "new mexico","new york","north carolina","north dakota","ohio","oklahoma","oregon",
  "pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","utah",
  "vermont","virginia","washington","west virginia","wisconsin","wyoming"
]);

function inferRegionLevelFromText(saRaw = "") {
  const s = saRaw.toLowerCase().trim();
  if (!s) return { level: "unknown", hint: null };
  if (US_STATES.has(s)) return { level: "state", hint: null };
  if (/\b(north|central|south|east|west|upper|lower)\s+(nj|jersey|new jersey)\b/.test(s)) return { level: "region", hint: "nj" };
  if (/\bcounty\b/.test(s)) return { level: "county", hint: null };
  if (/(,\s*)?(nj|new jersey|ny|new york|pa|pennsylvania|ct|connecticut)\b/.test(s)) return { level: "locality", hint: null };
  return { level: "unknown", hint: null };
}

function radiusByLevel(level) {
  switch (level) {
    case "state":     return 200_000;
    case "region":    return 120_000;
    case "county":    return  60_000;
    case "locality":  return  35_000;
    default:          return  80_000;
  }
}

async function geocodeServiceAreaForBias(serviceArea) {
  if (!serviceArea) return null;
  const inferred = inferRegionLevelFromText(serviceArea);
  try {
    const { data } = await mapsClient.geocode({
      params: { address: serviceArea, region: "us", key: MAPS_SERVER },
      timeout: 6000
    });
    const first = data?.results?.[0];
    if (!first) return null;
    const loc = first.geometry?.location;
    if (!loc) return null;

    const acTypes = new Set((first.address_components || []).flatMap(c => c.types));
    let level = inferred.level;
    if (acTypes.has("administrative_area_level_1")) level = "state";
    else if (acTypes.has("administrative_area_level_2")) level = "county";
    else if (acTypes.has("locality") || acTypes.has("postal_town")) level = "locality";

    return { lat: loc.lat, lng: loc.lng, level };
  } catch (e) {
    console.log("Geocode bias failed:", errPayload(e));
    return null;
  }
}

// ---------- PLACES HELPERS ----------
async function tryFindPlace(params) {
  const { data } = await mapsClient.findPlaceFromText({ params, timeout: 6000 });
  return data?.candidates || [];
}

// Prefer FindPlace (no unsupported fields) with radius bias; retry un-biased; fallback TextSearch
async function resolvePlaceCandidates({ businessName, serviceArea }) {
  const input = [businessName, serviceArea].filter(Boolean).join(" ").trim();
  const biasInfo = await geocodeServiceAreaForBias(serviceArea);

  try {
    const baseParams = {
      input,
      inputtype: "textquery",
      fields: ["place_id", "name", "formatted_address"], // IMPORTANT: FindPlace does NOT support 'website'
      region: "us",
      key: MAPS_SERVER
    };

    if (biasInfo?.lat && biasInfo?.lng) {
      const radius = radiusByLevel(biasInfo.level || "unknown");
      const biased = await tryFindPlace({
        ...baseParams,
        locationbias: `circle:${Math.max(20_000, radius)}@${biasInfo.lat},${biasInfo.lng}`
      });
      if (biased.length) return biased;

      const unBiased = await tryFindPlace(baseParams);
      if (unBiased.length) return unBiased;
    } else {
      const unBiased = await tryFindPlace(baseParams);
      if (unBiased.length) return unBiased;
    }
  } catch (e) {
    console.log("FindPlace miss:", errPayload(e));
  }

  try {
    const { data } = await mapsClient.textSearch({
      params: { query: input, region: "us", key: MAPS_SERVER },
      timeout: 7000
    });
    return data?.results || [];
  } catch (e) {
    console.log("TextSearch miss:", errPayload(e));
    return [];
  }
}

async function fetchPlaceDetails(placeId) {
  try {
    const { data } = await mapsClient.placeDetails({
      params: {
        place_id: placeId,
        fields: ["name", "website", "rating", "user_ratings_total", "formatted_address"], // website allowed here
        key: MAPS_SERVER
      },
      timeout: 6000
    });
    return data?.result || null;
  } catch (e) {
    console.log("PlaceDetails miss:", errPayload(e));
    return null;
  }
}

function pickBestCandidateByWebsite(candidates, websiteUrl) {
  if (!candidates?.length) return null;
  if (!websiteUrl) return candidates[0];

  let targetHost = null;
  try {
    targetHost = new URL(websiteUrl).hostname;
  } catch {
    targetHost = websiteUrl;
  }
  targetHost = normalizeHost(targetHost);
  if (!targetHost) return candidates[0];

  // If we already fetched details, candidate may not have website here; selection is revalidated later
  const exact = candidates.find((c) => c.website && normalizeHost(c.website) === targetHost);
  if (exact) return exact;

  const loose = candidates.find((c) => c.website && normalizeHost(c.website).includes(targetHost));
  return loose || candidates[0];
}

// ---------- PUPPETEER (optional Ads scrape) ----------
let sharedBrowserPromise;
async function getBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer
      .launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless
      })
      .catch((err) => {
        console.error("Browser launch failed:", err);
        throw err;
      });
  }
  return sharedBrowserPromise;
}

async function scrapeGoogleAds(domain) {
  if (!ENABLE_AD_SCRAPE) return [];
  if (IS_PRODUCTION && !/^true$/i.test(process.env.ENABLE_AD_SCRAPE_IN_PROD || "false")) return [];

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (compatible; Elev8Engine/1.0)");
    await page.goto("https://adstransparency.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 5000
    });
    await page.waitForSelector('input[placeholder="Advertiser name, topic or website"]', { timeout: 5000 });
    await page.type('input[placeholder="Advertiser name, topic or website"]', domain);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-test-id="ad-creative-card"]', { timeout: 5000 });
    const ads = await page.$$eval('[data-test-id="ad-creative-card"]', (nodes) =>
      nodes.slice(0, 3).map((n) => n.innerText || "")
    );
    return ads;
  } catch {
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ---------- REVERSE GEOCODE ----------
const reverseHandler = async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ success:false, error: "Latitude and longitude are required." });
  if (requireEnv(["GOOGLE_MAPS_API_KEY"], res)) return;

  try {
    const { data } = await mapsClient.reverseGeocode({
      params: {
        latlng: { lat: Number(lat), lng: Number(lon) },
        result_type: ["locality", "political"],
        key: MAPS_SERVER
      },
      timeout: 6000
    });

    const result = (data.results || [])[0];
    if (!result) return res.status(404).json({ success:false, error: "Could not find city for coordinates." });

    let city = "", state = "";
    for (const c of result.address_components) {
      if (c.types.includes("locality")) city = c.long_name;
      if (c.types.includes("administrative_area_level_1")) state = c.short_name;
    }
    return res.json({ success:true, cityState: [city, state].filter(Boolean).join(", ") });
  } catch (e) {
    console.error("Reverse geocode error:", errPayload(e));
    return res.status(500).json({ success:false, error: "Failed to reverse geocode." });
  }
};
app.get("/api/reverse", reverseHandler);
app.get("/reverse", reverseHandler);

// ---------- ANALYZE ----------
const analyzeHandler = async (req, res) => {
  const start = Date.now();
  const { businessName, websiteUrl, businessType, serviceArea } = req.body || {};
  const quickMode = req.query.quick === "1";

  console.log('[ANALYZE] start', {
    quickMode, path: req.path, businessName, serviceArea, businessType
  });

  // Quick mode
  if (quickMode) {
    const effectiveServiceArea = (serviceArea || "").toString().trim();
    const q = effectiveServiceArea ? `${businessName} ${effectiveServiceArea}` : businessName;
    return res.status(200).json({
      success: true,
      finalScore: 70,
      detailedScores: {
        "Overall Rating": 60,
        "Review Volume": 40,
        "Pain Point Resonance": 50,
        "Call-to-Action Strength": 50,
        "Website Health": 50,
        "On-Page SEO": 50
      },
      geminiAnalysis: {
        scores: {},
        topPriority: "Add your primary town and trade into the H1 and title tag.",
        competitorAdAnalysis: "Quick mode: external calls skipped.",
        reviewSentiment: "Quick mode: external calls skipped."
      },
      topCompetitor: null,
      mapEmbedUrl: buildMapEmbedUrl(q),
      clarifications: [] // none in quick mode
    });
  }

  // Validate input for full run
  if (!businessName || !websiteUrl || !businessType) {
    return res.status(400).json({
      success: false,
      message: "Please complete all required fields.",
      clarifications: [{
        message: "Missing fields. Please complete Business Name, Website URL, and Business Type."
      }]
    });
  }
  const normalizedWebsite = isHttpUrl(websiteUrl)
    ? websiteUrl
    : `https://${websiteUrl.replace(/^\/*/, "")}`;
  if (!isHttpUrl(normalizedWebsite)) {
    const raw = (websiteUrl || "").trim();
    const suggestion = looksLikeDomain(raw) ? `https://${raw}` : "";
    return res.status(400).json({
      success: false,
      message: "Invalid website URL.",
      clarifications: suggestion ? [{
        message: `Did you mean “${suggestion}”?`,
        suggestion: { field: "websiteUrl", value: suggestion, label: "Use suggested URL" }
      }] : []
    });
  }
  if (!["specialty", "maintenance"].includes(businessType)) {
    return res.status(400).json({ success: false, message: "Invalid businessType" });
  }
  if (requireEnv(["GOOGLE_MAPS_API_KEY"], res)) return;

  const effectiveServiceArea = (serviceArea || "").toString().trim();

  try {
    const candidates = await resolvePlaceCandidates({ businessName, serviceArea: effectiveServiceArea });
    console.log('[ANALYZE] candidates', { count: candidates?.length || 0, serviceArea: effectiveServiceArea });

    if (!candidates.length) {
      const clar = [];
      if (!effectiveServiceArea) {
        clar.push({
          message: "I didn’t find a Google Business Profile. Try adding a city or region.",
          suggestion: { field: "serviceArea", value: "Newark, NJ", label: "Try: Newark, NJ" }
        });
      } else {
        clar.push({
          message: `No matches for “${businessName}” in “${effectiveServiceArea}”. Try a nearby city or confirm spelling.`,
          suggestion: { field: "serviceArea", value: "Jersey City, NJ", label: "Try: Jersey City, NJ" }
        });
      }
      return res.status(404).json({
        success:false,
        error:"No Google Business Profile found for this query.",
        clarifications: clar
      });
    }

    // Pull details for each candidate to get website fields before choosing
    const enriched = await Promise.all(candidates.slice(0, 5).map(async c => {
      const det = c.place_id ? await fetchPlaceDetails(c.place_id) : null;
      return { ...c, website: det?.website, rating: det?.rating, user_ratings_total: det?.user_ratings_total };
    }));

    const picked = pickBestCandidateByWebsite(enriched, normalizedWebsite) || enriched[0];
    const userDetails = picked || null;

    const googleData = {
      rating: userDetails?.rating ?? 0,
      reviewCount: userDetails?.user_ratings_total ?? 0
    };

    // Competitor: any other candidate
    let topCompetitorData = null;
    let competitorAds = [];
    const competitorCandidate = enriched.find((c) => c.place_id && c.place_id !== picked.place_id);
    if (competitorCandidate) {
      topCompetitorData = {
        name: competitorCandidate?.name,
        website: competitorCandidate?.website || null
      };
      if (competitorCandidate?.website) {
        try {
          competitorAds = await scrapeGoogleAds(new URL(competitorCandidate.website).hostname);
        } catch {}
      }
    }

    const embedTarget = picked?.place_id
      ? `place_id:${picked.place_id}`
      : (effectiveServiceArea ? `${businessName} ${effectiveServiceArea}` : businessName);
    const mapEmbedUrl = buildMapEmbedUrl(embedTarget);

    // Gemini (optional)
    let geminiAnalysis = { scores: {}, topPriority: "", competitorAdAnalysis: "", reviewSentiment: "" };
    if (model) {
      const prompt = `
Analyze a local contractor:
- Business: "${businessName}"
- Market: "${effectiveServiceArea || "unknown"}"
- Model: "${businessType}"
- Website: "${normalizedWebsite}"

Return ONLY JSON:
{
  "scores": { "painPointResonance": 0-100, "ctaStrength": 0-100, "websiteHealth": 0-100, "onPageSEO": 0-100 },
  "topPriority": "<one actionable next step>",
  "competitorAdAnalysis": "<themes/offers>",
  "reviewSentiment": "<biggest positive theme>"
}`.trim();

      try {
        const gen = await withTimeout(
          model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 1024 }
          }),
          7000,
          "Gemini timeout"
        );
        const raw = gen?.response?.text() || "";
        const match = raw.match(/{[\s\S]*}/);
        if (match) geminiAnalysis = JSON.parse(match[0]);
      } catch (e) {
        console.warn("Gemini step skipped:", e.message);
      }
    }

    const { finalScore, detailedScores } = calculateFinalScore(
      googleData,
      geminiAnalysis.scores || {},
      businessType
    );

    console.log(`[ANALYZE] done in ${Date.now() - start}ms`, {
      placeId: picked?.place_id, rating: googleData.rating, reviews: googleData.reviewCount, finalScore
    });

    // Clarify if geo likely wrong (NJ intent but result far away)
    const clarifications = [];
    if (/new jersey|nj/i.test(effectiveServiceArea) && userDetails?.formatted_address && /,\s*KS\b/i.test(userDetails.formatted_address)) {
      clarifications.push({
        message: `I found a match in Kansas. Want to narrow to New Jersey?`,
        suggestion: { field: "serviceArea", value: "New Jersey", label: "Search New Jersey only" }
      });
    }

    return res.status(200).json({
      success: true,
      finalScore,
      detailedScores,
      geminiAnalysis,
      topCompetitor: topCompetitorData,
      mapEmbedUrl,
      clarifications
    });
  } catch (error) {
    console.error("[ANALYZE] FAIL", errPayload(error));
    return res.status(500).json({
      success: false,
      error: error?.message || "Analyze failed",
      clarifications: []
    });
  }
};

app.post("/api/analyze", analyzeHandler);
app.post("/analyze", analyzeHandler);

// ---------- SCORING ----------
function calculateFinalScore(googleData, geminiScores, businessType) {
  const ratingScore = clampPct((Number(googleData.rating || 0) / 5) * 100);
  const rc = Number(googleData.reviewCount || 0);
  const reviewScore = clampPct(Math.log10(Math.max(rc, 1)) * 25);

  const hasGemini =
    geminiScores &&
    ["painPointResonance", "ctaStrength", "websiteHealth", "onPageSEO"]
      .some(k => Number.isFinite(Number(geminiScores[k])));

  const painPointResonance = hasGemini ? clampPct(geminiScores.painPointResonance) : null;
  const ctaStrength        = hasGemini ? clampPct(geminiScores.ctaStrength)        : null;
  const websiteHealth      = hasGemini ? clampPct(geminiScores.websiteHealth)      : null;
  const onPageSEO          = hasGemini ? clampPct(geminiScores.onPageSEO)          : null;

  const fullWeights = (businessType === "maintenance")
    ? { rating: 0.20, review: 0.25, pain: 0.10, cta: 0.15, web: 0.15, seo: 0.15 }
    : { rating: 0.25, review: 0.25, pain: 0.20, cta: 0.10, web: 0.10, seo: 0.10 };

  const metrics = [
    { key: "rating", val: ratingScore,        w: fullWeights.rating },
    { key: "review", val: reviewScore,        w: fullWeights.review },
    { key: "pain",   val: painPointResonance, w: fullWeights.pain },
    { key: "cta",    val: ctaStrength,        w: fullWeights.cta },
    { key: "web",    val: websiteHealth,      w: fullWeights.web },
    { key: "seo",    val: onPageSEO,          w: fullWeights.seo }
  ].filter(m => m.val !== null && Number.isFinite(m.val));

  const totalW = metrics.reduce((s, m) => s + m.w, 0) || 1;
  const final = Math.round(metrics.reduce((s, m) => s + (m.val * (m.w / totalW)), 0));

  return {
    finalScore: Math.min(final || 70, 99),
    detailedScores: {
      "Overall Rating": ratingScore,
      "Review Volume": reviewScore,
      "Pain Point Resonance": painPointResonance ?? 0,
      "Call-to-Action Strength": ctaStrength ?? 0,
      "Website Health": websiteHealth ?? 0,
      "On-Page SEO": onPageSEO ?? 0
    }
  };
}

// ---------- START SERVER ----------
app
  .listen(PORT, () => {
    console.log(
      `Server running on http://localhost:${PORT} (ads scrape: ${ENABLE_AD_SCRAPE ? (IS_PRODUCTION ? "prod-guarded" : "on") : "off"})`
    );
  })
  .on("error", (err) => {
    console.error("Server listen failed:", err);
  });

module.exports = app;
