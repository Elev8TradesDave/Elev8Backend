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
const PORT = process.env.PORT || 3001;
const ENABLE_AD_SCRAPE = /^true$/i.test(process.env.ENABLE_AD_SCRAPE || "false");
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Keys (SPLIT)
const MAPS_SERVER = process.env.GOOGLE_MAPS_API_KEY || "";   // server: Places/Geocoding
const MAPS_EMBED  = process.env.GOOGLE_MAPS_EMBED_KEY || ""; // browser: Maps Embed (referrer-restricted)

// Gemini (optional)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro"; // override if needed

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
    geminiKeyPresent: Boolean(GEMINI_API_KEY),
    env: process.env.NODE_ENV || "unknown",
  });

app.get("/api/health", healthHandler);
app.get("/health", healthHandler);

// ---------- ROUTE-SCOPED ENV CHECKS ----------
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
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: GEMINI_MODEL }) : null;

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

const normalizeHost = (h) =>
  (h || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*/, "");

function hostFromUrl(u="") {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./,""); }
  catch { return String(u).toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").replace(/\/.*/,""); }
}

function levenshtein(a = "", b = "") {
  a = String(a); b = String(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({length: m+1}, () => Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0] = i;
  for (let j=0;j<=n;j++) dp[0][j] = j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) {
    const cost = a[i-1] === b[j-1] ? 0 : 1;
    dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
  }
  return dp[m][n];
}

function stateAbbrevFromAddress(addr="") {
  const m = String(addr).match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/);
  return m ? m[1] : null;
}

function normalizeStateText(s="") {
  s = s.toLowerCase().trim();
  if (!s) return null;
  if (/\bnew jersey\b|\bnj\b/.test(s)) return "NJ";
  if (/\bnew york\b|\bny\b/.test(s)) return "NY";
  if (/\bpennsylvania\b|\bpa\b/.test(s)) return "PA";
  if (/\bconnecticut\b|\bct\b/.test(s)) return "CT";
  return null;
}

async function buildClarificationQuestion({model, reason, suggestion}) {
  const fallback = `${reason} — Would you like me to try “${suggestion.label}”?`;
  if (!model) return fallback;
  try {
    const prompt = `Write one short, friendly question to a user (~15 words max).
Context: ${reason}
Offer this exact option label back to them: "${suggestion.label}".`;
    const gen = await withTimeout(
      model.generateContent({ contents:[{role:"user",parts:[{text:prompt}]}] }),
      3000, "clarify timeout"
    );
    const t = gen?.response?.text?.() || "";
    return (t || "").trim() || fallback;
  } catch {
    return fallback;
  }
}

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
    case "state":     return 200_000; // ~200 km
    case "region":    return 120_000; // ~120 km
    case "county":    return  60_000; // ~60 km
    case "locality":  return  35_000; // ~35 km
    default:          return  80_000; // fallback
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

// Prefer FindPlace with scaled radius; retry un-biased; fallback TextSearch.
// Also: enrich top candidates with PlaceDetails to get 'website' for better matching.
async function resolvePlaceCandidates({ businessName, serviceArea }) {
  const input = [businessName, serviceArea].filter(Boolean).join(" ").trim();
  const biasInfo = await geocodeServiceAreaForBias(serviceArea);

  const tryFindPlace = async (params) => {
    const { data } = await mapsClient.findPlaceFromText({ params, timeout: 7000 });
    return data?.candidates || [];
  };

  try {
    const baseParams = {
      input,
      inputtype: "textquery",
      // IMPORTANT: 'website' is NOT supported in FindPlace 'fields'; removing to avoid 400
      fields: ["place_id", "name", "formatted_address"],
      region: "us",
      key: MAPS_SERVER
    };

    // 1) Biased search with radius scaled to area type
    if (biasInfo?.lat && biasInfo?.lng) {
      const radius = radiusByLevel(biasInfo.level || "unknown");
      const biased = await tryFindPlace({
        ...baseParams,
        locationbias: `circle:${Math.max(20_000, radius)}@${biasInfo.lat},${biasInfo.lng}`
      });
      if (biased.length) return await enrichCandidatesWithDetails(biased);
      // 2) Retry same query with NO bias
      const unBiased = await tryFindPlace(baseParams);
      if (unBiased.length) return await enrichCandidatesWithDetails(unBiased);
    } else {
      // No geocode → go directly un-biased
      const unBiased = await tryFindPlace(baseParams);
      if (unBiased.length) return await enrichCandidatesWithDetails(unBiased);
    }
  } catch (e) {
    console.log("FindPlace miss:", errPayload(e));
  }

  // 3) Fallback: TextSearch (broader)
  try {
    const { data } = await mapsClient.textSearch({
      params: { query: input, region: "us", key: MAPS_SERVER },
      timeout: 7000
    });
    const results = data?.results || [];
    return await enrichCandidatesWithDetails(results.map(r => ({
      place_id: r.place_id, name: r.name, formatted_address: r.formatted_address
    })));
  } catch (e) {
    console.log("TextSearch miss:", errPayload(e));
    return [];
  }
}

async function enrichCandidatesWithDetails(cands) {
  const lim = cands.slice(0, 5);
  const out = [];
  for (const c of lim) {
    if (!c?.place_id) continue;
    try {
      const d = await fetchPlaceDetails(c.place_id);
      out.push({ ...c, website: d?.website, name: d?.name || c?.name, formatted_address: d?.formatted_address || c?.formatted_address });
    } catch {
      out.push(c);
    }
  }
  return out;
}

async function fetchPlaceDetails(placeId) {
  try {
    const { data } = await mapsClient.placeDetails({
      params: {
        place_id: placeId,
        fields: ["name", "website", "rating", "user_ratings_total", "formatted_address"],
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
    targetHost = normalizeHost(new URL(websiteUrl).hostname);
  } catch {
    targetHost = normalizeHost(websiteUrl);
  }
  if (!targetHost) return candidates[0];

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
  if (!lat || !lon) return res.status(400).json({ success:false, error: "Latitude and longitude are required." });

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

  // Quick mode only via ?quick=1
  const quickMode = req.query.quick === "1";

  console.log('[ANALYZE] start', {
    quickMode,
    bodyPresent: !!req.body,
    path: req.path,
    businessName,
    serviceArea,
    businessType
  });

  if (quickMode) {
    const effectiveServiceArea = (serviceArea || "").toString().trim();
    const q = effectiveServiceArea ? `${businessName} ${effectiveServiceArea}` : businessName;

    console.log('[ANALYZE] Quick mode forced via query param.');
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
      clarifications: []
    });
  }

  // Validate input for full run
  if (!businessName || !websiteUrl || !businessType) {
    return res.status(400).json({ success: false, message: "Please complete all required fields." });
  }
  const normalizedWebsite = isHttpUrl(websiteUrl)
    ? websiteUrl
    : `https://${websiteUrl.replace(/^\/*/, "")}`;
  if (!isHttpUrl(normalizedWebsite)) {
    return res.status(400).json({ success: false, message: "Invalid websiteUrl" });
  }
  if (!["specialty", "maintenance"].includes(businessType)) {
    return res.status(400).json({ success: false, message: "Invalid businessType" });
  }

  if (requireEnv(["GOOGLE_MAPS_API_KEY"], res)) return;

  const effectiveServiceArea = (serviceArea || "").toString().trim();

  try {
    const candidates = await resolvePlaceCandidates({ businessName, serviceArea: effectiveServiceArea });
    console.log('[ANALYZE] candidates', { count: candidates?.length || 0, serviceArea: effectiveServiceArea });

    const clarifications = [];

    if (!candidates.length) {
      const saState = normalizeStateText(effectiveServiceArea);
      if (saState) {
        const reason = `I couldn’t find a GBP using the whole state (${saState}).`;
        const suggestion = { field: "serviceArea", value: "Newark, NJ", label: "Try Newark, NJ" };
        clarifications.push({
          type: "serviceArea_narrow",
          message: await buildClarificationQuestion({ model, reason, suggestion }),
          suggestion
        });
      } else {
        clarifications.push({
          type: "try_city",
          message: "No exact match yet—want to try adding a city (e.g., “Plainfield, NJ”)?",
          suggestion: { field: "serviceArea", value: "Plainfield, NJ", label: "Use Plainfield, NJ" }
        });
      }
      return res.status(404).json({
        success: false,
        error: "No Google Business Profile found for this query.",
        clarifications
      });
    }

    const picked = pickBestCandidateByWebsite(candidates, normalizedWebsite);
    const userDetails = picked?.place_id ? await fetchPlaceDetails(picked.place_id) : null;

    // State mismatch clarification
    const resultState = stateAbbrevFromAddress(userDetails?.formatted_address || picked?.formatted_address || "");
    const desiredState = normalizeStateText(effectiveServiceArea);
    if (desiredState && resultState && desiredState !== resultState) {
      const reason = `I found “${userDetails?.name || picked?.name}” in ${resultState}, not ${desiredState}.`;
      const suggestion = { field: "serviceArea", value: `${resultState}`, label: `Search ${resultState} instead` };
      clarifications.push({
        type: "state_mismatch",
        message: await buildClarificationQuestion({ model, reason, suggestion }),
        suggestion
      });
    }

    // Website typo clarification
    if (userDetails?.website) {
      const inputHost = hostFromUrl(normalizedWebsite);
      const gbpHost   = hostFromUrl(userDetails.website);
      if (inputHost && gbpHost && inputHost !== gbpHost) {
        const dist = levenshtein(inputHost, gbpHost);
        if (dist <= 3 || inputHost.replace(/[^a-z]/g,"") === gbpHost.replace(/[^a-z]/g,"")) {
          const suggestion = { field: "websiteUrl", value: userDetails.website, label: `Use ${gbpHost}` };
          clarifications.push({
            type: "website_typo",
            message: await buildClarificationQuestion({
              model,
              reason: `Your website looks different from the GBP site I found (${gbpHost}).`,
              suggestion
            }),
            suggestion
          });
        } else if (!/\./.test(inputHost)) {
          const guess = `${inputHost}.com`;
          clarifications.push({
            type: "website_missing_tld",
            message: `Website might be missing “.com”. Try ${guess}?`,
            suggestion: { field: "websiteUrl", value: `https://${guess}`, label: `Use ${guess}` }
          });
        }
      }
    }

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

    console.log(
      `[ANALYZE] done in ${Date.now() - start}ms`,
      { placeId: picked?.place_id, rating: googleData.rating, reviews: googleData.reviewCount, finalScore }
    );

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
      error: error?.message || "Analyze failed"
    });
  }
};

app.post("/api/analyze", analyzeHandler);
app.post("/analyze", analyzeHandler);

// ---------- SCORING ----------
function calculateFinalScore(googleData, geminiScores, businessType) {
  const ratingScore = clampPct((Number(googleData.rating || 0) / 5) * 100);

  // Log curve for review volume: 1→0, 10→~25, 100→~50, 1k→~75, 10k→~100
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

// ---------- START SERVER (Render) ----------
app
  .listen(PORT, () => {
    console.log(
      `Server running on http://localhost:${PORT} (ads scrape: ${ENABLE_AD_SCRAPE ? (IS_PRODUCTION ? "prod-guarded" : "on") : "off"})`
    );
  })
  .on("error", (err) => {
    console.error("Server listen failed:", err);
  });

// Export app for tests (optional)
module.exports = app;
