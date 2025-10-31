/**
 * Elev8Trades Backend — Local Visibility Audit
 * Adaptive, trade-aware SEO/CTA/GBP scoring (Render-friendly)
 * File: api/server.js
 *
 * ENV (Render dashboard):
 *   NODE_ENV=production
 *   GOOGLE_MAPS_API_KEY_SERVER=<server-side places/details/textsearch key>
 *   GOOGLE_MAPS_EMBED_KEY=<client-safe embed key>
 *   GEMINI_API_KEY=<optional, not required>
 *   ENABLE_AD_SCRAPE=false
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const morgan = require("morgan");
const { Client } = require("@googlemaps/google-maps-services-js");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const GOOGLE_MAPS_API_KEY_SERVER = process.env.GOOGLE_MAPS_API_KEY_SERVER || "";
const GOOGLE_MAPS_EMBED_KEY = process.env.GOOGLE_MAPS_EMBED_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // optional

// ---------- Base Middleware ----------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(compression());
app.use(morgan("tiny"));
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        // allow Google Maps assets used by the embed (images, tiles, etc.)
        "img-src": ["'self'", "data:", "https:", "http:", "https://maps.gstatic.com", "https://maps.googleapis.com"],
        "frame-src": ["'self'", "https://www.google.com"],
        "connect-src": ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok =
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.startsWith("https://");
      return ok ? cb(null, true) : cb(null, false);
    },
  })
);
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Serve widget (static) from repo root so /widget.html works
app.use(express.static(path.join(__dirname, "..")));

// Silence favicon 404s (Chrome devtools, etc.)
app.get("/favicon.ico", (req, res) => res.status(204).end());

// ---------- Tiny in-memory cache (5 min default) ----------
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { data, expires }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data, ttl = CACHE_TTL_MS) {
  cache.set(key, { data, expires: Date.now() + ttl });
}

// ---------- Google Maps ----------
const gmaps = new Client();

async function mapsCall(fn, args, timeoutMs = 8000) {
  try {
    const res = await fn({ timeout: timeoutMs, ...args });
    return { ok: true, data: res.data };
  } catch (err) {
    const payload = err?.response?.data || err?.message || "Maps error";
    console.error("Maps error:", payload);
    return { ok: false, error: payload };
  }
}

// ---------- Utils ----------
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function normTo100(value, min, max) {
  if (value == null || Number.isNaN(value)) return 0;
  const clamped = Math.max(min, Math.min(max, value));
  return Math.round(((clamped - min) / (max - min)) * 100);
}
function normalizeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const url = new URL(s);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

// ---------- GBP (reviews-driven) ----------
function scoreReviews(avgRating, ratingsTotal) {
  const ratingScore = normTo100(avgRating || 0, 3.0, 5.0);
  const volumeScore = normTo100(ratingsTotal || 0, 0, 200);
  return Math.round(0.75 * ratingScore + 0.25 * volumeScore);
}
function scoreGBP(details) {
  const avg = details?.rating || 0;
  const total = details?.user_ratings_total || 0;
  const reviews = scoreReviews(avg, total);
  const photosCount = (details?.photos || []).length;
  const photosBoost = Math.min(10, Math.floor(photosCount / 5));
  return clamp(reviews + photosBoost, 0, 100);
}

// ---------- Fetch & analyze homepage (cached) ----------
async function fetchHtml(url, timeoutMs = 6000) {
  try {
    const key = `html:${url}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    const u = url.startsWith("http") ? url : `https://${url}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(u, { signal: controller.signal, redirect: "follow" });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("text/html")) {
      const out = { html: null, contentType: ct };
      cacheSet(key, out, 60 * 1000); // short-cache negative responses
      return out;
    }
    const html = await res.text();
    const out = { html, contentType: ct };
    cacheSet(key, out);
    return out;
  } catch {
    return { html: null, contentType: "" };
  }
}

// ---------- CTA scoring (rubric) ----------
function scoreCTA({ $, placePhone, placeHours }) {
  let pts = 0;
  const breakdown = { directCall: 0, contactPaths: 0, hoursPhone: 0, availability: 0 };

  // Direct call
  const telCount = $('a[href^="tel:"]').length;
  if (telCount >= 1) {
    pts += 25;
    breakdown.directCall += 25;
  }
  if (telCount >= 2) {
    const add = Math.min(5, (telCount - 1) * 2.5);
    pts += add;
    breakdown.directCall += add;
  }

  // Contact paths
  const CTA_WORDS = ["call", "quote", "estimate", "book", "schedule", "contact", "get started", "free estimate"];
  const ctaNodes = $("a,button")
    .filter((_, el) => {
      const t = $(el).text().toLowerCase().trim();
      return CTA_WORDS.some((w) => t.includes(w));
    })
    .length;
  if (ctaNodes >= 1) {
    pts += 15;
    breakdown.contactPaths += 15;
  }
  const extraCta = Math.min(10, Math.max(0, (ctaNodes - 1) * 5));
  pts += extraCta;
  breakdown.contactPaths += extraCta;

  const forms = $("form").length;
  if (forms > 0) {
    pts += 5;
    breakdown.contactPaths += 5;
  }

  // Hours & phone from Place
  if (placePhone) {
    pts += 10;
    breakdown.hoursPhone += 10;
  }
  if (placeHours) {
    pts += 5;
    breakdown.hoursPhone += 5;
  }

  // Availability keywords
  const bodyText = $("body").text().toLowerCase();
  const hasEmergencyWords = /(24\/7|24-7|same day|emergency)/.test(bodyText);
  if (hasEmergencyWords) {
    pts += 5;
    breakdown.availability += 5;
  }

  // Friction
  if (!placePhone && forms === 0 && ctaNodes === 0) {
    pts -= 15;
    breakdown.availability -= 15;
  }

  return { cta: clamp(pts, 0, 100), ctaBreakdown: breakdown, emergencyHint: hasEmergencyWords };
}

// ---------- SEO scoring (rubric) ----------
function scoreSEO($) {
  let pts = 0;
  const breakdown = {
    indexability: 0,
    titleMeta: 0,
    headingsContent: 0,
    internalLinks: 0,
    localMarkupNap: 0,
    uxHygiene: 0,
  };

  // A) Indexability
  const robots = $('meta[name="robots"]').attr("content")?.toLowerCase() || "";
  if (robots.includes("noindex")) {
    pts -= 20;
    breakdown.indexability -= 20;
  }
  if (robots.includes("nofollow")) {
    pts -= 10;
    breakdown.indexability -= 10;
  }
  if ($('link[rel="canonical"]').attr("href")) {
    pts += 5;
    breakdown.indexability += 5;
  }

  // B) Title & Meta
  const titleLen = ($("title").first().text() || "").trim().length;
  if (titleLen >= 20 && titleLen <= 65) {
    pts += 12;
    breakdown.titleMeta += 12;
  } else if ((titleLen >= 1 && titleLen < 20) || (titleLen >= 66 && titleLen <= 80)) {
    pts += 5;
    breakdown.titleMeta += 5;
  } else if (titleLen === 0 || titleLen > 120) {
    pts -= 10;
    breakdown.titleMeta -= 10;
  }

  const md = ($('meta[name="description"]').attr("content") || "").trim().length;
  if (md >= 120 && md <= 160) {
    pts += 10; breakdown.titleMeta += 10;
  } else if ((md >= 60 && md < 120) || (md > 160 && md <= 220)) {
    pts += 6; breakdown.titleMeta += 6;
  } else if (md === 0) {
    pts -= 8; breakdown.titleMeta -= 8;
  }

  // C) Headings & Content
  const h1Count = $("h1").length;
  if (h1Count >= 1) { pts += 8; breakdown.headingsContent += 8; }
  if (h1Count > 2) { pts -= 6; breakdown.headingsContent -= 6; }

  const text = $("body").text().replace(/\s+/g, " ");
  const wc = text.split(" ").filter(Boolean).length;
  if (wc >= 600) { pts += 10; breakdown.headingsContent += 10; }
  else if (wc >= 300) { pts += 6; breakdown.headingsContent += 6; }
  else if (wc >= 100) { pts += 3; breakdown.headingsContent += 3; }
  else { pts -= 4; breakdown.headingsContent -= 4; }

  // D) Internal links
  const internalLinks = $('a[href^="/"], a[href^="./"], a[href^="../"]').length;
  if (internalLinks >= 40) { pts += 12; breakdown.internalLinks += 12; }
  else if (internalLinks >= 15) { pts += 8; breakdown.internalLinks += 8; }
  else if (internalLinks >= 5) { pts += 4; breakdown.internalLinks += 4; }
  else if (internalLinks >= 1) { pts += 2; breakdown.internalLinks += 2; }

  const navLinks = $("nav a").length;
  if (navLinks >= 3) { pts += 3; breakdown.internalLinks += 3; }

  // E) Local SEO & NAP
  let hasLocal = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).contents().text());
      const arr = Array.isArray(j) ? j : [j];
      if (arr.some((x) => /LocalBusiness|Organization/i.test(x["@type"] || ""))) hasLocal = true;
    } catch {}
  });
  if (hasLocal) { pts += 10; breakdown.localMarkupNap += 10; }

  const hasMapIframe = $('iframe[src*="google.com/maps"], iframe[src*="maps.google."]').length > 0;
  if (hasMapIframe) { pts += 5; breakdown.localMarkupNap += 5; }

  const hasPhoneText = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/.test(text);
  const hasAddressText = /\d{1,5}\s+\w+(\s\w+){0,4}\s+(ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive)/i.test(text);
  if (hasPhoneText && hasAddressText) { pts += 10; breakdown.localMarkupNap += 10; }

  // F) UX/Crawl Hygiene
  const htmlStr = $.root().html() || "";
  const scriptLen = $("script").text().length + $("style").text().length;
  const ratio = scriptLen / Math.max(1, htmlStr.length);
  if (ratio > 0.6) { pts -= 6; breakdown.uxHygiene -= 6; }

  const imgs = $("img").slice(0, 20);
  const withAlt = imgs.filter((_, img) => !!$(img).attr("alt")).length;
  if (imgs.length >= 5 && withAlt / imgs.length >= 0.6) { pts += 3; breakdown.uxHygiene += 3; }

  if ($('link[rel="preconnect"], link[rel="preload"]').length > 0) { pts += 3; breakdown.uxHygiene += 3; }

  return { seo: clamp(pts, 0, 100), seoBreakdown: breakdown };
}

// ---------- Weighting strategy ----------
const BASE_WEIGHTS = {
  default: { seo: 0.50, cta: 0.30, gbp: 0.20 },
  roofing: { seo: 0.45, cta: 0.35, gbp: 0.20 },
  plumbing: { seo: 0.35, cta: 0.45, gbp: 0.20 },
  hvacRepair: { seo: 0.35, cta: 0.45, gbp: 0.20 },
  hvacInstall: { seo: 0.55, cta: 0.25, gbp: 0.20 },
  emergency: { seo: 0.40, cta: 0.40, gbp: 0.20 }, // generic emergency override
};

function pickWeights(trade, emergencyMode) {
  let key = "default";
  const t = (trade || "").toLowerCase();
  if (t.includes("roof")) key = "roofing";
  else if (t.includes("plumb")) key = "plumbing";
  else if (t.includes("hvac") || t.includes("air") || t.includes("heat")) {
    key = t.includes("install") ? "hvacInstall" : "hvacRepair";
  }
  const base = BASE_WEIGHTS[key] || BASE_WEIGHTS.default;
  if (emergencyMode) return BASE_WEIGHTS.emergency;
  return base;
}

// ---------- Helpers ----------
function makeMapEmbedUrl(placeId) {
  if (!placeId || !GOOGLE_MAPS_EMBED_KEY) return "";
  const base = "https://www.google.com/maps/embed/v1/place";
  const q = new URLSearchParams({ key: GOOGLE_MAPS_EMBED_KEY, q: `place_id:${placeId}` });
  return `${base}?${q.toString()}`;
}

function tradeToQuery(trade) {
  const t = (trade || "").toLowerCase();
  if (t.includes("roof")) return "roofing contractor";
  if (t.includes("plumb")) return "plumber";
  if (t.includes("hvac") && t.includes("install")) return "hvac installation";
  if (t.includes("hvac")) return "hvac repair";
  if (t.includes("electric")) return "electrician";
  if (t.includes("landscap")) return "landscaping";
  if (t.includes("mason")) return "masonry contractor";
  return t || "contractor";
}

// ---------- Routes ----------
app.get("/api/health", (req, res) => {
  const hasServerKey = !!GOOGLE_MAPS_API_KEY_SERVER;
  const hasEmbedKey = !!GOOGLE_MAPS_EMBED_KEY;
  res.json({
    ok: true,
    env: NODE_ENV,
    adsEnabled: false,
    keysReady: hasServerKey && hasEmbedKey,
    hasServerKey,
    hasEmbedKey,
  });
});

// Robust analyze with Text Search fallback + clarifications
app.post("/api/analyze", async (req, res) => {
  try {
    const { businessName, websiteUrl, serviceArea, tradeSelect, fast, placeId: forcedPlaceId } = req.body || {};
    if (!businessName && !forcedPlaceId) {
      return res.status(400).json({ success: false, error: "Missing businessName or placeId" });
    }

    let placeId = forcedPlaceId || null;

    // 1) Resolve place if placeId not provided
    if (!placeId) {
      const findArgs = {
        params: {
          key: GOOGLE_MAPS_API_KEY_SERVER,
          input: serviceArea ? `${businessName} ${serviceArea}` : businessName,
          inputtype: "textquery",
          fields: ["place_id", "name", "formatted_address"],
          language: "en",
          region: "us",
        },
      };
      const findRes = await mapsCall(gmaps.findPlaceFromText, findArgs);
      if (!findRes.ok) {
        return res.status(500).json({ success: false, error: `findPlaceFromText failed: ${findRes.error}` });
      }

      let cands = findRes.data?.candidates || [];

      // ---------- Fallback to Text Search if no candidates ----------
      if (!cands.length) {
        const q = serviceArea ? `${businessName} ${serviceArea}` : businessName;
        const tsArgs = {
          params: {
            key: GOOGLE_MAPS_API_KEY_SERVER,
            query: q,
            type: "establishment",
            language: "en",
            region: "us",
          },
        };
        const tsRes = await mapsCall(gmaps.textSearch, tsArgs);
        if (tsRes.ok) {
          const ts = tsRes.data?.results || [];
          if (ts.length) {
            const clar = ts.slice(0, 8).map((r) => ({
              place_id: r.place_id,
              name: r.name,
              formatted_address: r.formatted_address || r.vicinity || "",
            }));
            if (clar.length === 1) {
              placeId = clar[0].place_id;
            } else {
              return res.json({
                success: true,
                clarifications: {
                  reason: "MULTI_MATCH",
                  message: "Multiple matches found (via text search); please pick one.",
                  candidates: clar,
                },
              });
            }
          } else {
            return res.json({
              success: true,
              clarifications: {
                reason: "NO_MATCH",
                message: "No matching place found (name search + text search).",
                candidates: [],
              },
            });
          }
        } else {
          return res.json({
            success: true,
            clarifications: {
              reason: "NO_MATCH",
              message: "No matching place found. Try adding city/state, shortening the name, or pasting the website URL.",
              candidates: [],
            },
          });
        }
      }

      if (!placeId) {
        if (cands.length > 1) {
          return res.json({
            success: true,
            clarifications: {
              reason: "MULTI_MATCH",
              message: "Multiple matches found; please pick one.",
              candidates: cands.slice(0, 5).map((c) => ({
                place_id: c.place_id,
                name: c.name,
                formatted_address: c.formatted_address,
              })),
            },
          });
        }
        placeId = cands[0].place_id;
      }
    }

    // 2) Place details for scoring (cached)
    const detailsKey = `details:${placeId}`;
    let details = cacheGet(detailsKey);
    if (!details) {
      const detailsArgs = {
        params: {
          key: GOOGLE_MAPS_API_KEY_SERVER,
          place_id: placeId,
          fields: [
            "place_id",
            "name",
            "formatted_address",
            "website",
            "rating",
            "user_ratings_total",
            "photos",
            "formatted_phone_number",
            "opening_hours",
            "url",
            "geometry",
            "opening_hours.open_now",
          ],
          language: "en",
          region: "us",
        },
      };
      const detailsRes = await mapsCall(gmaps.placeDetails, detailsArgs);
      if (!detailsRes.ok) {
        return res.status(500).json({ success: false, error: `placeDetails failed: ${detailsRes.error}`, placeId });
      }
      details = detailsRes.data?.result || {};
      cacheSet(detailsKey, details);
    }
    const gbp = scoreGBP(details);

    // 3) SEO/CTA via homepage (skip if fast)
    let seo = 0, cta = 0, seoBreakdown = {}, ctaBreakdown = {};
    let emergencyWords = false;
    const usedWebsite = normalizeUrl(details.website || websiteUrl);

    if (!fast && usedWebsite) {
      const { html, contentType } = await fetchHtml(usedWebsite, 6000);
      if (html && (contentType || "").includes("text/html")) {
        const $ = cheerio.load(html);
        const ctaRes = scoreCTA({ $, placePhone: !!details.formatted_phone_number, placeHours: !!details.opening_hours });
        cta = ctaRes.cta;
        ctaBreakdown = ctaRes.ctaBreakdown;
        emergencyWords = ctaRes.emergencyHint;

        const seoRes = scoreSEO($);
        seo = seoRes.seo;
        seoBreakdown = seoRes.seoBreakdown;
      }
    }

    // 4) Determine mode & blend weights
    const hasSiteSignals = !fast && !!usedWebsite && (seo > 0 || cta > 0);
    const openNow = !!details?.opening_hours?.open_now;
    const emergencyMode = emergencyWords || openNow;

    let mode = "GBP_ONLY";
    let finalScore = gbp;

    if (hasSiteSignals) {
      const weights = pickWeights(tradeSelect, emergencyMode);
      const totalReviews = details?.user_ratings_total || 0;
      const gbpAdjFactor = totalReviews < 10 ? 0.7 : 1.0;

      finalScore = Math.round(
        (weights.seo * seo) + (weights.cta * cta) + (weights.gbp * gbp * gbpAdjFactor)
      );

      if (totalReviews >= 200) finalScore = clamp(finalScore + 2, 0, 100);
      if (ctaBreakdown?.directCall >= 25 && ctaBreakdown?.contactPaths >= 20) {
        finalScore = clamp(finalScore + 3, 0, 100);
      }

      mode = emergencyMode ? "EMERGENCY" : "BLENDED_DYNAMIC";
    }

    // 5) Secondary dials (for your UI)
    const reviewsDial = scoreReviews(details?.rating, details?.user_ratings_total);
    const painDial = Math.max(0, 100 - reviewsDial);

    const mapEmbedUrl = makeMapEmbedUrl(placeId);

    res.json({
      success: true,
      placeId,
      place: {
        name: details?.name,
        address: details?.formatted_address,
        website: usedWebsite || null,
        rating: details?.rating ?? null,
        user_ratings_total: details?.user_ratings_total ?? null,
        open_now: openNow,
      },
      finalScore,
      mode,
      seo,
      cta,
      gbp,
      seoBreakdown,
      ctaBreakdown,
      dials: { reviews: reviewsDial, pain: painDial },
      mapEmbedUrl,
      weightsUsed: hasSiteSignals ? pickWeights(tradeSelect, emergencyMode) : { seo: 0, cta: 0, gbp: 1 },
    });
  } catch (err) {
    console.error("Analyze route error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error",
      details: err.message,
    });
  }
});

app.post("/api/competitive-snapshot", async (req, res) => {
  try {
    const { placeId, trade, area } = req.body || {};

    // Optional geometry bias from place
    let locationBias = null;
    if (placeId) {
      const dKey = `geom:${placeId}`;
      let geom = cacheGet(dKey);
      if (!geom) {
        const dRes = await mapsCall(gmaps.placeDetails, {
          params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: placeId, fields: ["geometry", "name"], language: "en", region: "us" },
        });
        if (dRes.ok) {
          const g = dRes.data?.result?.geometry?.location;
          geom = g?.lat && g?.lng ? { lat: g.lat, lng: g.lng } : null;
          cacheSet(dKey, geom);
        }
      }
      if (geom) locationBias = geom;
    }

    const base = tradeToQuery(trade);
    const query = area ? `${base} ${area}` : base;

    const tsKey = `textsearch:${query}:${locationBias ? `${locationBias.lat},${locationBias.lng}` : "x"}`;
    let basics = cacheGet(tsKey);
    if (!basics) {
      const tsArgs = {
        params: {
          key: GOOGLE_MAPS_API_KEY_SERVER,
          query,
          type: "establishment",
          language: "en",
          region: "us",
          ...(locationBias ? { location: locationBias, radius: 15000 } : {}),
        },
      };
      const tsRes = await mapsCall(gmaps.textSearch, tsArgs);
      if (!tsRes.ok) return res.status(500).json({ success: false, error: `textSearch failed: ${tsRes.error}` });
      basics = (tsRes.data?.results || []).slice(0, 10);
      cacheSet(tsKey, basics);
    }

    const enriched = [];
    for (const b of basics) {
      const eKey = `details:${b.place_id}`;
      let r = cacheGet(eKey);
      if (!r) {
        const dRes = await mapsCall(gmaps.placeDetails, {
          params: {
            key: GOOGLE_MAPS_API_KEY_SERVER,
            place_id: b.place_id,
            fields: ["place_id", "name", "formatted_address", "rating", "user_ratings_total", "photos", "website"],
            language: "en",
            region: "us",
          },
        });
        if (dRes.ok) {
          r = dRes.data?.result || {};
          cacheSet(eKey, r);
        }
      }
      if (r) {
        enriched.push({
          place_id: r.place_id,
          name: r.name,
          address: r.formatted_address,
          rating: r.rating ?? null,
          user_ratings_total: r.user_ratings_total ?? null,
          website: r.website || null,
          photoCount: (r.photos || []).length,
        });
      }
    }

    res.json({
      success: true,
      queryUsed: query,
      biasedBy: locationBias,
      competitors: enriched,
      adIntel: {
        googleAdsTransparency: "https://adstransparency.google.com/",
        metaAdLibrary: "https://www.facebook.com/ads/library/",
      },
    });
  } catch (err) {
    console.error("Competitive snapshot error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch competitors",
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Elev8Trades backend running on port ${PORT} [${NODE_ENV}]`);
});
