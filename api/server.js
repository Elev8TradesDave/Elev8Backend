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
// Avoid v1beta 404s
const model = process.env.GEMINI_API_KEY
  ? genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" })
  : null;

// ---------- UTILS ----------
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const normalizeHost = (h) => (h || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*/, "");
const looksLikeDomain = (s = "") => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s);

const isHttpUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// --- Name & Service Area normalization ---
const COMPANY_SUFFIXES = /\b(inc\.?|llc|l\.l\.c\.|corp\.?|co\.?|ltd\.?|limited|company)\b/gi;
function cleanBusinessName(name = "") {
  return String(name)
    .toLowerCase()
    .replace(COMPANY_SUFFIXES, "")
    .replace(/[^a-z0-9&\-'\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeServiceArea(sa = "") {
  const s = String(sa).trim().replace(/\s*,\s*/g, ", ");
  return s.replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

// ---------- STATE CODE HELPERS (case-insensitive; full names + 2-letter) ----------
const STATE_NAME_TO_CODE = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA","colorado":"CO",
  "connecticut":"CT","delaware":"DE","district of columbia":"DC","dc":"DC","florida":"FL","georgia":"GA",
  "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY",
  "louisiana":"LA","maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI","minnesota":"MN",
  "mississippi":"MS","missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH",
  "new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND","ohio":"OH",
  "oklahoma":"OK","oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
  "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY"
};

function serviceAreaStateCode(sa = "") {
  const s = String(sa).trim().toLowerCase();

  // two-letter code anywhere
  const m = s.match(
    /\b(al|ak|az|ar|ca|co|ct|de|dc|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i
  );
  if (m) return m[1].toUpperCase();

  // full name
  for (const name in STATE_NAME_TO_CODE) {
    if (s.includes(name)) return STATE_NAME_TO_CODE[name];
  }
  return null;
}

// ---------- AREA CLASSIFICATION + RADIUS ----------
const US_STATES = new Set(Object.keys(STATE_NAME_TO_CODE));

function inferRegionLevelFromText(saRaw = "") {
  const s = saRaw.toLowerCase().trim();
  if (!s) return { level: "unknown", hint: null };
  if (US_STATES.has(s)) return { level: "state", hint: null };
  if (/\b(north|central|south|east|west|upper|lower)\s+(nj|jersey|new jersey)\b/i.test(s)) return { level: "region", hint: "nj" };
  if (/\bcounty\b/i.test(s)) return { level: "county", hint: null };
  if (/(,\s*)?(nj|new jersey|ny|new york|pa|pennsylvania|ct|connecticut)\b/i.test(s)) return { level: "locality", hint: null };
  return { level: "unknown", hint: null };
}

function radiusByLevel(level) {
  switch (level) {
    case "state":     return 200_000;
    case "region":    return 120_000;
    case "county":    return  60_000;
    case "locality":  return  50_000; // increased from 35k
    default:          return  80_000;
  }
}

async function geocodeServiceAreaForBias(serviceArea) {
  const normalized = normalizeServiceArea(serviceArea || "");
  if (!normalized) return null;
  const inferred = inferRegionLevelFromText(normalized);
  try {
    const { data } = await mapsClient.geocode({
      params: { address: normalized, region: "us", key: MAPS_SERVER },
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

// ---------- Tiny retry helper for Maps calls ----------
async function withOneRetry(fn, label = "maps") {
  try {
    return await fn();
  } catch (e) {
    const status = e?.response?.status;
    const code = e?.response?.data?.status;
    if (status === 429 || code === "OVER_QUERY_LIMIT") {
      await sleep(350);
      try { return await fn(); } catch (e2) { throw e2; }
    }
    throw e;
  }
}

// ---------- PLACES CACHE (LRU-ish) ----------
const PLACE_CACHE = new Map();
const PLACE_TTL_MS = 60 * 60 * 1000; // 1h
function getFromCache(id) {
  const hit = PLACE_CACHE.get(id);
  if (!hit) return null;
  if (Date.now() > hit.exp) { PLACE_CACHE.delete(id); return null; }
  PLACE_CACHE.delete(id);
  PLACE_CACHE.set(id, hit);
  return hit.val;
}
function setCache(id, val) {
  PLACE_CACHE.set(id, { val, exp: Date.now() + PLACE_TTL_MS });
  if (PLACE_CACHE.size > 500) {
    const firstKey = PLACE_CACHE.keys().next().value;
    PLACE_CACHE.delete(firstKey);
  }
}

// ---------- PLACES HELPERS ----------
async function tryFindPlace(params) {
  const call = () => mapsClient.findPlaceFromText({ params, timeout: 6000 });
  const { data } = await withOneRetry(call, "findPlaceFromText");
  return data?.candidates || [];
}

// Robust resolver: tries domain, name+area variants, with FindPlace/TextSearch
async function resolvePlaceCandidates({ businessName, serviceArea, websiteUrl, businessType }) {
  const cleanedName = cleanBusinessName(businessName || "");
  const normalizedSA = normalizeServiceArea(serviceArea || "");
  const biasInfo = await geocodeServiceAreaForBias(normalizedSA);
  const stateHint = serviceAreaStateCode(normalizedSA);

  // Domain host from website
  let host = "";
  try { host = new URL(websiteUrl || "").hostname; } catch {
    host = normalizeHost(websiteUrl || "");
  }

  // helpers
  const tryFind = async (q, withBias = true) => {
    const base = {
      input: q,
      inputtype: "textquery",
      fields: ["place_id", "name", "formatted_address"], // allowed in FindPlace
      region: "us",
      key: MAPS_SERVER
    };
    const params =
      withBias && biasInfo?.lat && biasInfo?.lng
        ? {
            ...base,
            locationbias: `circle:${Math.max(20000, radiusByLevel(biasInfo.level || "unknown"))}@${biasInfo.lat},${biasInfo.lng}`
          }
        : base;
    const out = await tryFindPlace(params);
    return out;
  };

  const tryText = async (q, withBias = true) => {
    const params = { query: q, region: "us", key: MAPS_SERVER };
    if (withBias && biasInfo?.lat && biasInfo?.lng) {
      params.location = { lat: biasInfo.lat, lng: biasInfo.lng };
      params.radius = Math.max(20000, radiusByLevel(biasInfo.level || "unknown"));
    }
    const call = () => mapsClient.textSearch({ params, timeout: 7000 });
    const { data } = await withOneRetry(call, "textSearch");

    const rawResults = data?.results || [];
    let results = rawResults;

    // State hint filter: apply only if it doesn't nuke everything
    if (stateHint) {
      const re = new RegExp(`,\\s*${stateHint}\\b`, "i");
      const filtered = rawResults.filter(r => re.test(r.formatted_address || ""));
      if (filtered.length) results = filtered;
    }
    return results;
  };

  // Build query variants
  const nospaceName = cleanedName.replace(/\s+/g, "");
  const specialtyTerm = businessType === "specialty" ? "roofing contractor" : "maintenance";

  const variants = [
    host && { type: "find", q: host, bias: true },
    host && { type: "find", q: host, bias: false },

    cleanedName && normalizedSA && { type: "find", q: `${cleanedName} ${normalizedSA}`, bias: true },
    cleanedName && normalizedSA && { type: "find", q: `${cleanedName} ${normalizedSA}`, bias: false },

    nospaceName && normalizedSA && { type: "text", q: `${nospaceName} ${normalizedSA}`, bias: true },
    cleanedName && normalizedSA && { type: "text", q: `${cleanedName} ${specialtyTerm} ${normalizedSA}`, bias: true },

    host && { type: "text", q: host, bias: true },
    cleanedName && { type: "text", q: cleanedName, bias: false }
  ].filter(Boolean);

  for (const v of variants) {
    try {
      const out = v.type === "find" ? await tryFind(v.q, v.bias) : await tryText(v.q, v.bias);
      if (out?.length) return out;
    } catch (e) {
      console.log("Search variant miss:", v, errPayload(e));
    }
  }
  return [];
}

async function fetchPlaceDetails(placeId) {
  const cached = getFromCache(placeId);
  if (cached) return cached;
  try {
    const call = () => mapsClient.placeDetails({
      params: {
        place_id: placeId,
        fields: ["name", "website", "rating", "user_ratings_total", "formatted_address"],
        key: MAPS_SERVER
      },
      timeout: 6000
    });
    const { data } = await withOneRetry(call, "placeDetails");
    const result = data?.result || null;
    if (result) setCache(placeId, result);
    return result;
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
  const { businessName, websiteUrl, businessType, serviceArea, selectedPlaceId } = req.body || {};
  const quickMode = req.query.quick === "1";

  console.log('[ANALYZE] start', {
    quickMode, path: req.path, businessName, serviceArea, businessType, selectedPlaceId
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

  // Fast path: the UI already gave us the chosen place
  if (selectedPlaceId) {
    const det = await fetchPlaceDetails(selectedPlaceId);
    if (det) {
      const picked = {
        place_id: selectedPlaceId,
        name: det.name,
        website: det.website,
        rating: det.rating,
        user_ratings_total: det.user_ratings_total,
        formatted_address: det.formatted_address
      };

      const googleData = {
        rating: picked.rating ?? 0,
        reviewCount: picked.user_ratings_total ?? 0
      };

      const embedTarget = `place_id:${picked.place_id}`;
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

      console.log(`[ANALYZE] done (selected) in ${Date.now() - start}ms`, {
        placeId: picked.place_id, rating: googleData.rating, reviews: googleData.reviewCount, finalScore
      });

      return res.status(200).json({
        success: true,
        finalScore,
        detailedScores,
        geminiAnalysis,
        topCompetitor: null,
        mapEmbedUrl,
        clarifications: []
      });
    }
    // if details fetch failed, continue into normal resolution flow below
  }

  try {
    const candidates = await resolvePlaceCandidates({
      businessName,
      serviceArea: effectiveServiceArea,
      websiteUrl: normalizedWebsite,
      businessType
    });
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
      const pid = c.place_id || c.placeId;
      const det = pid ? await fetchPlaceDetails(pid) : null;
      return {
        ...c,
        place_id: pid,
        website: det?.website,
        rating: det?.rating ?? c.rating,
        user_ratings_total: det?.user_ratings_total ?? c.user_ratings_total,
        formatted_address: det?.formatted_address || c.formatted_address || c.address
      };
    }));

    // If multiple & no exact domain match -> ask the user to choose
    const byExactDomain = (c) => c.website && normalizeHost(c.website) === normalizeHost(normalizedWebsite);
    const exactDomain = enriched.find(byExactDomain);

    if (!exactDomain && enriched.length > 1) {
      const candidatesPayload = enriched.map(c => ({
        placeId: c.place_id,
        name: c.name,
        address: c.formatted_address,
        rating: c.rating ?? 0,
        reviews: c.user_ratings_total ?? 0
      }));
      return res.status(200).json({
        success: false,
        message: "Multiple possible matches found. Please select the correct business.",
        candidates: candidatesPayload
      });
    }

    const picked = exactDomain || pickBestCandidateByWebsite(enriched, normalizedWebsite) || enriched[0];
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
