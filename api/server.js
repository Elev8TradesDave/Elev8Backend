/**
 * Elev8Trades Backend (Render/Vercel-friendly, IPv6-safe)
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
const serverless = require("serverless-http");
const path = require("path");

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3001;
const ENABLE_AD_SCRAPE = /^true$/i.test(process.env.ENABLE_AD_SCRAPE || "false");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Keys (SPLIT)
const MAPS_SERVER = process.env.GOOGLE_MAPS_API_KEY || "";        // server: Places, Geocoding
const MAPS_EMBED  = process.env.GOOGLE_MAPS_EMBED_KEY || "";      // browser: Maps Embed (referrer-restricted)

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
    keyGenerator: (req) => ipFromReq(req),
    validate: false,
    skipFailedRequests: true
  })
);

// Stop browsers from hitting the lambda for icons
app.use("/favicon.ico", (_req, res) => res.status(204).end());
app.use("/favicon.png", (_req, res) => res.status(204).end());

// ---------- SERVE WIDGET AT ROOT ----------
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "widget.html"));
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

// ---------- ROUTE-SCOPED ENV CHECKS ----------
function requireEnv(keys, res) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Missing env:", missing.join(", "));
    res.status(500).json({ error: `Server configuration missing: ${missing.join(", ")}` });
    return true;
  }
  return false;
}

// ---------- CLIENTS ----------
const mapsClient = new Client({});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model =
  process.env.GEMINI_API_KEY ? genAI.getGenerativeModel({ model: "gemini-1.5-pro" }) : null;

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
  return { msg: e?.message, status, data: dataStr, stack: e?.stack };
};

// ---------- PLACE MATCH HELPERS ----------
const normalizeHost = (h) =>
  (h || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*/, "");

async function geocodeServiceAreaForBias(serviceArea) {
  if (!serviceArea) return null;
  try {
    const { data } = await mapsClient.geocode({
      params: { address: serviceArea, region: "us", key: MAPS_SERVER },
      timeout: 5000
    });
    const loc = data?.results?.[0]?.geometry?.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch (e) {
    console.log("Geocode bias failed:", errPayload(e));
    return null;
  }
}

// Prefer FindPlaceFromText with a tight bias; falls back to TextSearch.
async function resolvePlaceCandidates({ businessName, serviceArea }) {
  const input = [businessName, serviceArea].filter(Boolean).join(" ").trim();
  const bias = await geocodeServiceAreaForBias(serviceArea);

  // Try FindPlaceFromText first (precise + fast)
  try {
    const params = {
      input,
      inputtype: "textquery",
      // IMPORTANT: 'website' is NOT supported here
      fields: ["place_id", "name", "formatted_address"],
      region: "us",
      key: MAPS_SERVER
    };
    // REST format: "circle:5000@lat,lng"
    if (bias) params.locationbias = `circle:5000@${bias.lat},${bias.lng}`;

    const { data } = await mapsClient.findPlaceFromText({ params, timeout: 5000 });
    if (data?.candidates?.length) return data.candidates;
  } catch (e) {
    console.log("FindPlace miss:", errPayload(e));
  }

  // Fallback: TextSearch (broader)
  try {
    const { data } = await mapsClient.textSearch({
      params: { query: input, region: "us", key: MAPS_SERVER },
      timeout: 5000
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
        fields: ["name", "website", "rating", "user_ratings_total", "formatted_address"],
        key: MAPS_SERVER
      },
      timeout: 5000
    });
    return data?.result || null;
  } catch (e) {
    console.log("PlaceDetails miss:", errPayload(e));
    return null;
  }
}

function pickBestCandidateByWebsite(candidates, websiteUrl) {
  // Most FindPlace/TextSearch candidates won't include website; we'll still prefer the first.
  if (!candidates?.length) return null;
  if (!websiteUrl) return candidates[0];

  let targetHost = null;
  try {
    targetHost = normalizeHost(new URL(websiteUrl).hostname);
  } catch {
    targetHost = normalizeHost(websiteUrl);
  }
  if (!targetHost) return candidates[0];

  // If any candidate has website (e.g., from TextSearch or later augmentation), try to match.
  const exact = candidates.find((c) => c.website && normalizeHost(c.website) === targetHost);
  if (exact) return exact;

  const loose = candidates.find((c) => c.website && normalizeHost(c.website).includes(targetHost));
  return loose || candidates[0];
}

// ---------- PUPPETEER (Render-friendly) ----------
let sharedBrowserPromise;
async function getBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer
      .launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(), // works on Render
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
  } catch (e) {
    console.log(`Ad scrape skipped for ${domain}: ${e.message}`);
    return [];
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ---------- REVERSE GEOCODE ----------
const reverseHandler = async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: "Latitude and longitude are required." });

  if (requireEnv(["GOOGLE_MAPS_API_KEY"], res)) return;

  try {
    const { data } = await mapsClient.reverseGeocode({
      params: {
        latlng: { lat: Number(lat), lng: Number(lon) },
        result_type: ["locality", "political"],
        key: MAPS_SERVER
      },
      timeout: 5000
    });

    const result = (data.results || [])[0];
    if (!result) return res.status(404).json({ error: "Could not find city for coordinates." });

    let city = "", state = "";
    for (const c of result.address_components) {
      if (c.types.includes("locality")) city = c.long_name;
      if (c.types.includes("administrative_area_level_1")) state = c.short_name;
    }
    return res.json({ cityState: [city, state].filter(Boolean).join(", ") });
  } catch (e) {
    console.error("Reverse geocode error:", errPayload(e));
    return res.status(500).json({ error: "Failed to reverse geocode." });
  }
};

app.get("/api/reverse", reverseHandler);
app.get("/reverse", reverseHandler);

// ---------- ANALYZE ----------
const analyzeHandler = async (req, res) => {
  const start = Date.now();
  const { businessName, websiteUrl, businessType, serviceArea } = req.body || {};

  // QUICK MODE: fast smoke test (no external calls)
  const quickMode =
    req.query.quick === "1" || req.headers["x-quick"] === "1" || req.headers["x-skip-external"] === "1";

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
      mapEmbedUrl: buildMapEmbedUrl(q)
    });
  }

  // Validate input for full run
  if (!businessName || !websiteUrl || !businessType) {
    return res.status(400).json({ success: false, message: "Please complete all required fields." });
  }
  // Accept bare domains by normalizing to https://
  const normalizedWebsite = isHttpUrl(websiteUrl)
    ? websiteUrl
    : `https://${websiteUrl.replace(/^\/*/, "")}`;
  if (!isHttpUrl(normalizedWebsite)) {
    return res.status(400).json({ success: false, message: "Invalid websiteUrl" });
  }
  if (!["specialty", "maintenance"].includes(businessType)) {
    return res.status(400).json({ success: false, message: "Invalid businessType" });
  }

  // Full mode requires Maps; Gemini is optional
  if (requireEnv(["GOOGLE_MAPS_API_KEY"], res)) return;

  const effectiveServiceArea = (serviceArea || "").toString().trim();

  try {
    // Resolve candidates, pick best by website host (if available)
    const candidates = await resolvePlaceCandidates({ businessName, serviceArea: effectiveServiceArea });

    if (!candidates.length) {
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
          competitorAdAnalysis: "No competitor detected for this query.",
          reviewSentiment: "Not enough public reviews to summarize."
        },
        topCompetitor: null,
        mapEmbedUrl: buildMapEmbedUrl(q)
      });
    }

    const picked = pickBestCandidateByWebsite(candidates, normalizedWebsite);
    const userDetails = picked?.place_id ? await fetchPlaceDetails(picked.place_id) : null;

    const googleData = {
      rating: userDetails?.rating ?? 0,
      reviewCount: userDetails?.user_ratings_total ?? 0
    };

    // Competitor: take next candidate if available
    let topCompetitorData = null;
    let competitorAds = [];
    const competitorCandidate = candidates.find((c) => c.place_id && c.place_id !== picked.place_id);
    if (competitorCandidate) {
      try {
        const cd = await fetchPlaceDetails(competitorCandidate.place_id);
        if (cd?.website) {
          topCompetitorData = { name: cd.name || competitorCandidate.name, website: cd.website };
          try {
            const domain = new URL(cd.website).hostname;
            competitorAds = await scrapeGoogleAds(domain);
          } catch {}
        } else {
          topCompetitorData = { name: cd?.name || competitorCandidate.name, website: null };
        }
      } catch (e) {
        console.log("Competitor details skipped:", e.message);
      }
    }

    // Map embed
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

      const gen = await withTimeout(
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 1024 }
        }),
        7000,
        "Gemini timeout"
      );
      try {
        const raw = gen.response.text() || "";
        const match = raw.match(/{[\s\S]*}/);
        if (match) geminiAnalysis = JSON.parse(match[0]);
      } catch (e) {
        console.warn("Gemini parse failed:", e.message);
      }
    }

    const { finalScore, detailedScores } = calculateFinalScore(
      googleData,
      geminiAnalysis.scores || {},
      businessType
    );

    console.log(`Analyze done in ${Date.now() - start}ms for "${businessName}"`, {
      placeId: picked?.place_id,
      rating: googleData.rating,
      reviews: googleData.reviewCount
    });

    return res.status(200).json({
      success: true,
      finalScore,
      detailedScores,
      geminiAnalysis,
      topCompetitor: topCompetitorData,
      mapEmbedUrl
    });
  } catch (error) {
    console.error("[analyze] FAIL", errPayload(error));
    const q =
      effectiveServiceArea ? `${businessName} ${effectiveServiceArea}` : (businessName || "Unknown");
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
        competitorAdAnalysis: "LLM unavailable or timed out.",
        reviewSentiment: "Not enough public reviews to summarize."
      },
      topCompetitor: null,
      mapEmbedUrl: buildMapEmbedUrl(q)
    });
  }
};

app.post("/api/analyze", analyzeHandler);
app.post("/analyze", analyzeHandler);

// ---------- SCORING ----------
function calculateFinalScore(googleData, geminiScores, businessType) {
  // Core signals from Google
  const ratingScore = clampPct((Number(googleData.rating || 0) / 5) * 100);
  const reviewScore = clampPct(Math.min(Number(googleData.reviewCount || 0) / 150, 1) * 100);

  const hasGemini =
    geminiScores &&
    ["painPointResonance", "ctaStrength", "websiteHealth", "onPageSEO"]
      .some(k => Number.isFinite(Number(geminiScores[k])));

  const painPointResonance = hasGemini ? clampPct(geminiScores.painPointResonance) : null;
  const ctaStrength        = hasGemini ? clampPct(geminiScores.ctaStrength)        : null;
  const websiteHealth      = hasGemini ? clampPct(geminiScores.websiteHealth)      : null;
  const onPageSEO          = hasGemini ? clampPct(geminiScores.onPageSEO)          : null;

  // Baseline weights when all metrics present
  const fullWeights = (businessType === "maintenance")
    ? { rating: 0.15, review: 0.15, pain: 0.05, cta: 0.25, web: 0.15, seo: 0.15 }
    : { rating: 0.20, review: 0.15, pain: 0.20, cta: 0.05, web: 0.15, seo: 0.15 };

  // Use only available metrics; renormalize weights to 1
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

// ---------- EXPORT FOR VERCEL + LOCAL LISTEN ----------
module.exports = serverless(app);

if (!process.env.VERCEL) {
  app
    .listen(PORT, () =>
      console.log(
        `Local server on http://localhost:${PORT} (ads scrape: ${ENABLE_AD_SCRAPE ? (IS_PRODUCTION ? "prod-guarded" : "on") : "off"})`
      )
    )
    .on("error", (err) => {
      console.error("Server listen failed:", err);
    });
}
