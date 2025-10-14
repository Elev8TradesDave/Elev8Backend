/**
 * Elev8Trades Backend (Vercel-ready, IPv6-safe)
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
const path = require("path"); // <-- ADDED

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3001;
const ENABLE_AD_SCRAPE = /^true$/i.test(process.env.ENABLE_AD_SCRAPE || "false");
const isVercel = !!process.env.VERCEL;

// ---------- APP ----------
const app = express();
app.set("trust proxy", 1);

// Secure HTTP headers (defaults only; fine for JSON APIs)
app.use(helmet());

// Allow all origins (this is an API)
app.use(cors());

// JSON body parsing (keep it small)
app.use(express.json({ limit: "200kb" }));

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
    skipFailedRequests: true,
  })
);

// Stop browsers from hitting the lambda for icons
app.use("/favicon.ico", (_req, res) => res.status(204).end());
app.use("/favicon.png", (_req, res) => res.status(204).end());

// ---------- SERVE WIDGET AT ROOT ----------
// When someone opens https://<your-domain>/, send widget.html
app.get("/", (_req, res) => {
  // __dirname is .../api/, widget.html lives one level up
  res.sendFile(path.join(__dirname, "..", "widget.html"));
});

// ---------- HEALTH (fast & zero deps) ----------
const healthHandler = (_req, res) =>
  res.json({
    ok: true,
    mapsKeyPresent: Boolean(process.env.GOOGLE_MAPS_API_KEY),
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    env: process.env.NODE_ENV || "unknown",
  });
app.get("/api/health", healthHandler);
app.get("/health", healthHandler);

// ---------- CONFIG GUARD (after health) ----------
app.use((req, res, next) => {
  if (!process.env.GOOGLE_MAPS_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error("Missing required API keys");
    return res
      .status(500)
      .json({ error: "Server configuration missing API keys" });
  }
  next();
});

// ---------- CLIENTS ----------
const mapsClient = new Client({});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

// ---------- UTILS ----------
const clampPct = (n) =>
  Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const isHttpUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
};

const withTimeout = (p, ms, label = "timeout") =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(label)), ms)
    ),
  ]);

let sharedBrowserPromise;
async function getBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: isVercel ? await chromium.executablePath() : undefined,
      headless: chromium.headless,
    });
  }
  return sharedBrowserPromise;
}

async function scrapeGoogleAds(domain) {
  if (!ENABLE_AD_SCRAPE) return [];
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (compatible; Elev8Engine/1.0)");
    await page.goto("https://adstransparency.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 5000,
    });
    await page.waitForSelector(
      'input[placeholder="Advertiser name, topic or website"]',
      { timeout: 5000 }
    );
    await page.type(
      'input[placeholder="Advertiser name, topic or website"]',
      domain
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-test-id="ad-creative-card"]', {
      timeout: 5000,
    });
    const ads = await page.$$eval(
      '[data-test-id="ad-creative-card"]',
      (nodes) => nodes.slice(0, 3).map((n) => n.innerText || "")
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
  if (!lat || !lon)
    return res
      .status(400)
      .json({ error: "Latitude and longitude are required." });
  try {
    const { data } = await mapsClient.reverseGeocode({
      params: {
        latlng: { lat: Number(lat), lng: Number(lon) },
        result_type: ["locality", "political"],
        key: process.env.GOOGLE_MAPS_API_KEY,
      },
      timeout: 5000,
    });
    const result = (data.results || [])[0];
    if (!result)
      return res
        .status(404)
        .json({ error: "Could not find city for coordinates." });

    let city = "",
      state = "";
    for (const c of result.address_components) {
      if (c.types.includes("locality")) city = c.long_name;
      if (c.types.includes("administrative_area_level_1"))
        state = c.short_name;
    }
    return res.json({ cityState: [city, state].filter(Boolean).join(", ") });
  } catch (e) {
    console.error("Reverse geocode error:", e.message);
    return res.status(500).json({ error: "Failed to reverse geocode." });
  }
};
app.get("/api/reverse", reverseHandler);
app.get("/reverse", reverseHandler);

// ---------- ANALYZE ----------
const analyzeHandler = async (req, res) => {
  const start = Date.now();
  const { businessName, websiteUrl, businessType, serviceArea } =
    req.body || {};

  // QUICK MODE: return fast fallback to verify wiring (no external calls)
  const quickMode =
    req.query.quick === "1" ||
    req.headers["x-quick"] === "1" ||
    req.headers["x-skip-external"] === "1";

  if (quickMode) {
    const MAPS = process.env.GOOGLE_MAPS_API_KEY || "";
    const effectiveServiceArea = (serviceArea || "").toString().trim();
    const q = effectiveServiceArea
      ? `${businessName} ${effectiveServiceArea}`
      : businessName;
    return res.status(200).json({
      success: true,
      finalScore: 70,
      detailedScores: {
        "Overall Rating": 60,
        "Review Volume": 40,
        "Pain Point Resonance": 50,
        "Call-to-Action Strength": 50,
        "Website Health": 50,
        "On-Page SEO": 50,
      },
      geminiAnalysis: {
        scores: {},
        topPriority: "Add your primary town and trade into the H1 and title tag.",
        competitorAdAnalysis: "Quick mode: external calls skipped.",
        reviewSentiment: "Quick mode: external calls skipped.",
      },
      topCompetitor: null,
      mapEmbedUrl: `https://www.google.com/maps/embed/v1/place?key=${MAPS}&q=${encodeURIComponent(
        q || "Business"
      )}`,
    });
  }

  // Validate input for full run
  if (!businessName || !websiteUrl || !businessType) {
    return res
      .status(400)
      .json({ success: false, message: "Missing required fields." });
  }
  if (!isHttpUrl(websiteUrl)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid websiteUrl" });
  }
  if (!["specialty", "maintenance"].includes(businessType)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid businessType" });
  }

  const MAPS = process.env.GOOGLE_MAPS_API_KEY;
  const effectiveServiceArea = (serviceArea || "").toString().trim();
  const primaryQuery = effectiveServiceArea
    ? `${businessName} ${effectiveServiceArea}`
    : businessName;
  const fallbackQuery = `${businessName} contractor`;

  try {
    // Google Places search (5s)
    let placesResponse = await mapsClient.textSearch({
      params: { query: primaryQuery, key: MAPS },
      timeout: 5000,
    });
    let allResults = placesResponse.data.results || [];
    if (allResults.length === 0) {
      placesResponse = await mapsClient.textSearch({
        params: { query: fallbackQuery, key: MAPS },
        timeout: 5000,
      });
      allResults = placesResponse.data.results || [];
    }

    // If still nothing, return a safe canned result
    if (allResults.length === 0) {
      return res.status(200).json({
        success: true,
        finalScore: 70,
        detailedScores: {
          "Overall Rating": 60,
          "Review Volume": 40,
          "Pain Point Resonance": 50,
          "Call-to-Action Strength": 50,
          "Website Health": 50,
          "On-Page SEO": 50,
        },
        geminiAnalysis: {
          scores: {},
          topPriority:
            "Add your primary town and trade into the H1 and title tag.",
          competitorAdAnalysis: "No competitor detected for this query.",
          reviewSentiment: "Not enough public reviews to summarize.",
        },
        topCompetitor: null,
        mapEmbedUrl: `https://www.google.com/maps/embed/v1/place?key=${MAPS}&q=${encodeURIComponent(
          primaryQuery
        )}`,
      });
    }

    const userBusiness = allResults[0];
    const topCompetitor =
      allResults.find((r) => r.place_id !== userBusiness.place_id) || null;

    const detailsForUser = await mapsClient.placeDetails({
      params: {
        place_id: userBusiness.place_id,
        fields: ["name", "rating", "user_ratings_total", "reviews"],
        key: MAPS,
      },
      timeout: 5000,
    });
    const userDetails = detailsForUser.data.result || {};
    const googleData = {
      rating: userDetails.rating || 4.0,
      reviewCount: userDetails.user_ratings_total || 0,
    };
    const reviewSnippets = (userDetails.reviews || [])
      .slice(0, 5)
      .map((r) => r.text || "");

    let topCompetitorData = null;
    let competitorAds = [];
    if (topCompetitor) {
      try {
        const competitorDetails = await mapsClient.placeDetails({
          params: {
            place_id: topCompetitor.place_id,
            fields: ["name", "website"],
            key: MAPS,
          },
          timeout: 5000,
        });
        const comp = competitorDetails.data.result || {};
        if (comp.website) {
          topCompetitorData = {
            name: comp.name || topCompetitor.name,
            website: comp.website,
          };
          const domain = new URL(comp.website).hostname;
          competitorAds = await scrapeGoogleAds(domain);
        } else {
          topCompetitorData = {
            name: comp.name || topCompetitor.name,
            website: null,
          };
        }
      } catch (e) {
        console.log("Competitor details scrape skipped:", e.message);
      }
    }

    const searchQuery = effectiveServiceArea
      ? `${businessName} ${effectiveServiceArea}`
      : `${businessName}`;
    const mapEmbedUrl = `https://www.google.com/maps/embed/v1/place?key=${MAPS}&q=${encodeURIComponent(
      searchQuery
    )}`;

    const geminiPrompt = `
Analyze a local contractor:
- Business: "${businessName}"
- Market: "${effectiveServiceArea || "unknown"}"
- Model: "${businessType}"
- Website: "${websiteUrl}"

Recent public review snippets (up to 5):
${JSON.stringify(reviewSnippets)}

Top competitor: "${topCompetitorData?.name || "unknown"}"
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
}`.trim();

    // Guard Gemini with a 7s timeout so we stay under hobby plan limits
    const gen = await withTimeout(
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: geminiPrompt }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
      7000,
      "Gemini timeout"
    );

    let raw = gen.response.text() || "";
    const match = raw.match(/{[\s\S]*}/);
    if (!match) throw new Error("Gemini did not return JSON.");
    let geminiAnalysis = JSON.parse(match[0]);

    const { finalScore, detailedScores } = calculateFinalScore(
      googleData,
      geminiAnalysis.scores || {},
      businessType
    );

    console.log(`Analyze done in ${Date.now() - start}ms for "${businessName}"`);
    return res.status(200).json({
      success: true,
      finalScore,
      detailedScores,
      geminiAnalysis,
      topCompetitor: topCompetitorData,
      mapEmbedUrl,
    });
  } catch (error) {
    console.error("[analyze] FAIL", {
      msg: error?.message,
      stack: error?.stack,
    });
    // Final safety fallback: never 500 for users
    const MAPS = process.env.GOOGLE_MAPS_API_KEY;
    const q =
      (req.body?.serviceArea
        ? `${req.body.businessName} ${req.body.serviceArea}`
        : req.body?.businessName) || "Unknown";
    return res.status(200).json({
      success: true,
      finalScore: 70,
      detailedScores: {
        "Overall Rating": 60,
        "Review Volume": 40,
        "Pain Point Resonance": 50,
        "Call-to-Action Strength": 50,
        "Website Health": 50,
        "On-Page SEO": 50,
      },
      geminiAnalysis: {
        scores: {},
        topPriority:
          "Add your primary town and trade into the H1 and title tag.",
        competitorAdAnalysis: "LLM unavailable or timed out.",
        reviewSentiment: "Not enough public reviews to summarize.",
      },
      topCompetitor: null,
      mapEmbedUrl: `https://www.google.com/maps/embed/v1/place?key=${MAPS}&q=${encodeURIComponent(
        q
      )}`,
    });
  }
};
app.post("/api/analyze", analyzeHandler);
app.post("/analyze", analyzeHandler);

// ---------- SCORING ----------
function calculateFinalScore(googleData, geminiScores, businessType) {
  const ratingScore = clampPct((Number(googleData.rating || 0) / 5) * 100);
  const reviewScore = clampPct(
    Math.min(Number(googleData.reviewCount || 0) / 150, 1) * 100
  );

  const allScores = {
    rating: ratingScore,
    reviewVolume: reviewScore,
    painPointResonance: clampPct(geminiScores.painPointResonance),
    ctaStrength: clampPct(geminiScores.ctaStrength),
    websiteHealth: clampPct(geminiScores.websiteHealth),
    onPageSEO: clampPct(geminiScores.onPageSEO),
  };

  let final;
  if (businessType === "specialty") {
    final = Math.round(
      allScores.rating * 0.2 +
        allScores.reviewVolume * 0.15 +
        allScores.painPointResonance * 0.2 +
        allScores.ctaStrength * 0.05 +
        allScores.websiteHealth * 0.15 +
        allScores.onPageSEO * 0.15
    );
  } else {
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
      "Overall Rating": allScores.rating,
      "Review Volume": allScores.reviewVolume,
      "Pain Point Resonance": allScores.painPointResonance,
      "Call-to-Action Strength": allScores.ctaStrength,
      "Website Health": allScores.websiteHealth,
      "On-Page SEO": allScores.onPageSEO,
    },
  };
}

// ---------- EXPORT FOR VERCEL + LOCAL LISTEN ----------
module.exports = serverless(app);

if (!process.env.VERCEL) {
  app.listen(PORT, () =>
    console.log(
      `Local server on http://localhost:${PORT} (ads scrape: ${
        ENABLE_AD_SCRAPE ? "on" : "off"
      })`
    )
  );
}
