/**
 * Elev8Trades Backend — Local Visibility Audit (SAB-friendly, Render-ready)
 * File: api/server.js
 *
 * ENV (Render):
 *   NODE_ENV=production
 *   GOOGLE_MAPS_API_KEY_SERVER=...
 *   GOOGLE_MAPS_EMBED_KEY=...
 *   GEMINI_API_KEY=...          (optional, unused in this file)
 *   ENABLE_AD_SCRAPE=false      (ignored here; no scraping)
 *
 * Node 18+ required (global fetch).
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

// ---------- Middleware ----------
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(compression());

// Silence health checks in logs
app.use(
  morgan("tiny", {
    skip: (req) =>
      req.url === "/api/health" ||
      req.method === "HEAD" ||
      req.url === "/favicon.ico",
  })
);

// CSP allowlists for Maps embeds and photo hosts
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": [
          "'self'",
          "data:",
          "https:",
          "http:",
          "https://maps.gstatic.com",
          "https://maps.googleapis.com",
          "https://lh3.googleusercontent.com",
          "https://lh5.googleusercontent.com",
        ],
        "frame-src": ["'self'", "https://www.google.com"],
        "connect-src": ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// CORS (localhost + any https origin by default; tighten if you want)
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

// Simple rate limit
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Serve widget (repo root)
app.use(express.static(path.join(__dirname, "..")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "widget.html")));
app.get("/favicon.ico", (req, res) => res.status(204).end());

// ---------- Cache ----------
// 6h for place details (reduces quota/latency); 1h for html probes
const TTL_DETAILS_MS = 6 * 60 * 60 * 1000;
const TTL_HTML_MS = 60 * 60 * 1000;
const cache = new Map(); // key -> { data, expires }
const now = () => Date.now();
const cacheGet = (k) => {
  const hit = cache.get(k);
  if (!hit) return null;
  if (now() > hit.expires) {
    cache.delete(k);
    return null;
  }
  return hit.data;
};
const cacheSet = (k, data, ttl) => cache.set(k, { data, expires: now() + ttl });

// nocache helper
const noCache = (req) => String(req.query?.nocache || "").trim() === "1";

// ---------- Google Maps ----------
const gmaps = new Client();
async function mapsCall(method, args, timeoutMs = 8000) {
  try {
    const res = await method.call(gmaps, { timeout: timeoutMs, ...args });
    return { ok: true, data: res.data };
  } catch (err) {
    const payload = err?.response?.data || err?.message || "Maps error";
    console.error(JSON.stringify({ at: "maps", error: payload }));
    return { ok: false, error: payload };
  }
}

// ---------- Utils ----------
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const normalizeUrl = (u) => {
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
};

// ---------- SAB Place Resolution ----------
function expandNameVariants(name = "") {
  const n = name.trim();
  const out = new Set([n]);
  out.add(n.replace(/\binc\.?\b/gi, "").trim());
  out.add(n.replace(/\bllc\b/gi, "").trim());
  out.add(n.replace(/\bco\.?\b/gi, "").trim());
  out.add(n.replace(/\bcorp\.?\b/gi, "").trim());
  out.add(n.replace(/\ball\s*state\b/gi, "Allstate"));
  out.add(n.replace(/\ballstate\b/gi, "All State"));
  return Array.from(out).filter(Boolean);
}

function expandTradeSynonyms(trade = "") {
  const t = trade.toLowerCase();
  const map = {
    "home improvement": ["general contractor", "remodeling contractor", "home remodeler"],
    electrician: ["electrical contractor"],
    plumber: ["plumbing contractor"],
    roofer: ["roofing contractor"],
    masonry: ["masonry contractor", "concrete contractor"],
    landscaper: ["landscaping contractor", "lawn care"],
  };
  return map[t] || [];
}

async function geocodeCenter(area) {
  if (!area) return null;
  try {
    const geo = await mapsCall(gmaps.geocode, {
      params: { address: area, key: GOOGLE_MAPS_API_KEY_SERVER },
    });
    const c = geo.ok && geo.data?.results?.[0]?.geometry?.location;
    return c ? { lat: c.lat, lng: c.lng } : null;
  } catch {
    return null;
  }
}

async function resolvePlaceRobust({ businessName, businessType, serviceArea }) {
  const center = await geocodeCenter(serviceArea);
  const nameVariants = expandNameVariants(businessName);
  const tradeVariants = [businessType, ...expandTradeSynonyms(businessType)].filter(Boolean);

  const queries = new Set();
  for (const n of nameVariants) {
    queries.add(`${n}, ${serviceArea}`);
    if (businessType) queries.add(`${n} ${businessType} ${serviceArea}`);
    for (const tv of tradeVariants) queries.add(`${n} ${tv} ${serviceArea}`);
  }
  queries.add(`${businessName} ${serviceArea}`);

  for (const q of Array.from(queries)) {
    const params = { query: q, key: GOOGLE_MAPS_API_KEY_SERVER, region: "us" };
    if (center) {
      params.location = center;
      params.radius = 80000; // ~80km bias for SABs
    }
    const resp = await mapsCall(gmaps.textSearch, { params });
    const results = resp.ok ? resp.data?.results || [] : [];
    if (results.length) {
      return { results, queryTried: q, centerUsed: !!center };
    }
  }
  return { results: [], queryTried: null, centerUsed: !!center };
}

// ---------- GBP Score (v1 spec) ----------
function scoreReviewVolume(count) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (count < 5) return 0.25;
  if (count < 20) return 0.40;
  if (count < 50) return 0.60;
  if (count < 100) return 0.80;
  if (count < 250) return 0.90;
  return 1.0;
}
function computeGbpScore(details, expectedTradeLabel /* e.g., "electrician" */) {
  const rating = Number(details?.rating) || 0;
  const reviews = Number(details?.user_ratings_total) || 0;
  const hasPhotos = Array.isArray(details?.photos) && details.photos.length > 0;
  const hasHours = !!details?.opening_hours;
  const primaryType = Array.isArray(details?.types) ? details.types[0] : "";
  const categoryText = details?.editorial_summary?.overview || primaryType || "";

  const ratingNorm = clamp(rating / 5, 0, 1);
  const volNorm = scoreReviewVolume(reviews);
  const trade = (expectedTradeLabel || "").toLowerCase();
  const catText = String(categoryText || "").toLowerCase();
  const categoryNorm = trade ? (catText.includes(trade) ? 1 : 0.6) : 0.8;
  const photosNorm = hasPhotos ? 1 : 0;
  const hoursNorm = hasHours ? 1 : 0;

  const W = { ratingQuality: 0.40, reviewVolume: 0.25, categoryMatch: 0.15, photos: 0.10, hours: 0.10 };

  const gbpScore =
    (ratingNorm * W.ratingQuality +
      volNorm * W.reviewVolume +
      categoryNorm * W.categoryMatch +
      photosNorm * W.photos +
      hoursNorm * W.hours) * 100;

  return {
    score: Math.round(gbpScore),
    subs: {
      ratingQuality: Math.round(ratingNorm * 100),
      reviewVolume: Math.round(volNorm * 100),
      categoryMatch: Math.round(categoryNorm * 100),
      photos: Math.round(photosNorm * 100),
      hours: Math.round(hoursNorm * 100),
      raw: { rating, reviews, primaryType },
    },
  };
}

// ---------- Site Probe (HEAD + quick checks) ----------
async function probeSite(url, { timeoutMs = 4000 } = {}) {
  try {
    if (!url) return { checked: false, reachable: false, https: false, hasContact: false, contentLen: 0 };
    let u = url.trim();
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(u, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    clearTimeout(t);

    const reachable = res.ok;
    const https = u.startsWith("https://");
    const cl = Number(res.headers.get("content-length")) || 0;

    // best-effort /contact HEAD
    let hasContact = false;
    try {
      const cu = new URL(u);
      cu.pathname = "/contact";
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), timeoutMs);
      const cRes = await fetch(cu.toString(), { method: "HEAD", redirect: "follow", signal: ctrl2.signal });
      clearTimeout(t2);
      hasContact = cRes.ok;
    } catch {}

    return { checked: true, reachable, https, hasContact, contentLen: cl, url: u };
  } catch (e) {
    return { checked: true, reachable: false, https: /^https:\/\//i.test(url || ""), hasContact: false, contentLen: 0, url };
  }
}

// ---------- HTML fetch (GET) for SEO/CTA ----------
async function fetchHtml(url, timeoutMs = 6000, useCache = true) {
  const u = normalizeUrl(url);
  if (!u) return { html: null, contentType: "" };

  const key = `html:${u}`;
  if (useCache) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(u, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);

    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !ct.includes("text/html")) {
      const out = { html: null, contentType: ct };
      cacheSet(key, out, TTL_HTML_MS);
      return out;
    }
    const html = await res.text();
    const out = { html, contentType: ct };
    cacheSet(key, out, TTL_HTML_MS);
    return out;
  } catch {
    return { html: null, contentType: "" };
  }
}

// ---------- CTA scoring ----------
function scoreCTA({ $, placePhone, placeHours }) {
  let pts = 0;
  const breakdown = { directCall: 0, contactPaths: 0, hoursPhone: 0, availability: 0 };

  const telCount = $('a[href^="tel:"]').length;
  if (telCount >= 1) {
    pts += 25; breakdown.directCall += 25;
    if (telCount >= 2) { const add = Math.min(5, (telCount - 1) * 2.5); pts += add; breakdown.directCall += add; }
  }

  const CTA_WORDS = ["call", "quote", "estimate", "book", "schedule", "contact", "get started", "free estimate"];
  const ctaNodes = $("a,button").filter((_, el) => CTA_WORDS.some((w) => ($(el).text() || "").toLowerCase().includes(w))).length;
  if (ctaNodes >= 1) { pts += 15; breakdown.contactPaths += 15; }
  const extraCta = Math.min(10, Math.max(0, (ctaNodes - 1) * 5));
  pts += extraCta; breakdown.contactPaths += extraCta;

  const forms = $("form").length;
  if (forms > 0) { pts += 5; breakdown.contactPaths += 5; }

  if (placePhone) { pts += 10; breakdown.hoursPhone += 10; }
  if (placeHours) { pts += 5; breakdown.hoursPhone += 5; }

  const bodyText = ($("body").text() || "").toLowerCase();
  const hasEmergencyWords = /(24\/7|24-7|same day|emergency)/.test(bodyText);
  if (hasEmergencyWords) { pts += 5; breakdown.availability += 5; }

  if (!placePhone && forms === 0 && ctaNodes === 0) { pts -= 15; breakdown.availability -= 15; }

  return { cta: clamp(pts, 0, 100), ctaBreakdown: breakdown, emergencyHint: hasEmergencyWords };
}

// ---------- SEO scoring ----------
function scoreSEO($) {
  let pts = 0;
  const breakdown = {
    indexability: 0, titleMeta: 0, headingsContent: 0, internalLinks: 0, localMarkupNap: 0, uxHygiene: 0,
  };

  const robots = $('meta[name="robots"]').attr("content")?.toLowerCase() || "";
  if (robots.includes("noindex")) { pts -= 20; breakdown.indexability -= 20; }
  if (robots.includes("nofollow")) { pts -= 10; breakdown.indexability -= 10; }
  if ($('link[rel="canonical"]').attr("href")) { pts += 5; breakdown.indexability += 5; }

  const titleLen = ($("title").first().text() || "").trim().length;
  if (titleLen >= 20 && titleLen <= 65) { pts += 12; breakdown.titleMeta += 12; }
  else if ((titleLen >= 1 && titleLen < 20) || (titleLen >= 66 && titleLen <= 80)) { pts += 5; breakdown.titleMeta += 5; }
  else if (titleLen === 0 || titleLen > 120) { pts -= 10; breakdown.titleMeta -= 10; }

  const md = ($('meta[name="description"]').attr("content") || "").trim().length;
  if (md >= 120 && md <= 160) { pts += 10; breakdown.titleMeta += 10; }
  else if ((md >= 60 && md < 120) || (md > 160 && md <= 220)) { pts += 6; breakdown.titleMeta += 6; }
  else if (md === 0) { pts -= 8; breakdown.titleMeta -= 8; }

  const h1Count = $("h1").length;
  if (h1Count >= 1) { pts += 8; breakdown.headingsContent += 8; }
  if (h1Count > 2) { pts -= 6; breakdown.headingsContent -= 6; }

  const text = $("body").text().replace(/\s+/g, " ");
  const wc = text.split(" ").filter(Boolean).length;
  if (wc >= 600) { pts += 10; breakdown.headingsContent += 10; }
  else if (wc >= 300) { pts += 6; breakdown.headingsContent += 6; }
  else if (wc >= 100) { pts += 3; breakdown.headingsContent += 3; }
  else { pts -= 4; breakdown.headingsContent -= 4; }

  const internalLinks = $('a[href^="/"], a[href^="./"], a[href^="../"]').length;
  if (internalLinks >= 40) { pts += 12; breakdown.internalLinks += 12; }
  else if (internalLinks >= 15) { pts += 8; breakdown.internalLinks += 8; }
  else if (internalLinks >= 5) { pts += 4; breakdown.internalLinks += 4; }
  else if (internalLinks >= 1) { pts += 2; breakdown.internalLinks += 2; }

  const navLinks = $("nav a").length;
  if (navLinks >= 3) { pts += 3; breakdown.internalLinks += 3; }

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

// ---------- Trade-aware Site weights (seo vs cta) ----------
const SITE_WEIGHTS = {
  default: { seo: 0.6, cta: 0.4 },
  roofing: { seo: 0.55, cta: 0.45 },
  plumbing: { seo: 0.45, cta: 0.55 },
  hvacRepair: { seo: 0.45, cta: 0.55 },
  hvacInstall: { seo: 0.65, cta: 0.35 },
  emergency: { seo: 0.5, cta: 0.5 },
};
function pickSiteWeights(trade, emergencyMode) {
  let key = "default";
  const t = (trade || "").toLowerCase();
  if (t.includes("roof")) key = "roofing";
  else if (t.includes("plumb")) key = "plumbing";
  else if (t.includes("hvac") || t.includes("air") || t.includes("heat")) {
    key = t.includes("install") ? "hvacInstall" : "hvacRepair";
  }
  const base = SITE_WEIGHTS[key] || SITE_WEIGHTS.default;
  return emergencyMode ? SITE_WEIGHTS.emergency : base;
}

// Embed URL
const makeMapEmbedUrl = (placeId) => {
  if (!placeId || !GOOGLE_MAPS_EMBED_KEY) return "";
  const base = "https://www.google.com/maps/embed/v1/place";
  const q = new URLSearchParams({ key: GOOGLE_MAPS_EMBED_KEY, q: `place_id:${placeId}` });
  return `${base}?${q.toString()}`;
};

// ---------- Routes ----------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    keysReady: !!(GOOGLE_MAPS_API_KEY_SERVER && GOOGLE_MAPS_EMBED_KEY),
    hasServerKey: !!GOOGLE_MAPS_API_KEY_SERVER,
    hasEmbedKey: !!GOOGLE_MAPS_EMBED_KEY,
  });
});

/**
 * Analyze (SAB-aware, adaptive scoring)
 * Request body:
 *  - businessName (string) OR placeId (string)
 *  - serviceArea (string) required unless placeId provided
 *  - websiteUrl (string, optional)
 *  - businessType/tradeSelect (string, optional)
 *  - fast (boolean/number: 1 to skip HTML fetch)
 */
app.post("/api/analyze", async (req, res) => {
  const t0 = Date.now();
  const { businessName, websiteUrl, serviceArea, businessType, tradeSelect, fast, placeId: overridePlaceId } = req.body || {};
  const log = (o) => console.log(JSON.stringify({ at: "analyze", ...o }));

  if (!overridePlaceId && !businessName) {
    return res.status(400).json({ success: false, error: "bad_request", message: "businessName or placeId is required" });
  }
  if (!overridePlaceId && !serviceArea) {
    return res.status(400).json({ success: false, error: "bad_request", message: "serviceArea is required when placeId is not provided" });
  }

  try {
    const bypassCache = noCache(req);
    let details = null, placeId = null, ambiguous = null, queryTried = null, centerUsed = null;

    // ---- Resolve place ----
    if (overridePlaceId) {
      placeId = overridePlaceId;
    } else {
      const r = await resolvePlaceRobust({ businessName, businessType: businessType || tradeSelect, serviceArea });
      const results = r.results || [];
      queryTried = r.queryTried; centerUsed = r.centerUsed;

      if (results.length > 1) {
        ambiguous = results.slice(0, 3).map(c => ({
          name: c.name,
          vicinity: c.vicinity || c.formatted_address,
          place_id: c.place_id
        }));
      }
      placeId = results[0]?.place_id || null;
    }

    // ---- If no GBP but we have a website → SITE_ONLY ----
    const providedWebsite = normalizeUrl(websiteUrl);
    if (!placeId && providedWebsite) {
      const siteProbe = await probeSite(providedWebsite, { timeoutMs: 4000 });
      const reachable = !!siteProbe.reachable;

      // Optional HTML scoring if not fast and reachable
      let seo = 0, cta = 0, emergencyWords = false, seoBreakdown = {}, ctaBreakdown = {};
      if (!fast && reachable) {
        const { html, contentType } = await fetchHtml(providedWebsite, 6000, !bypassCache);
        if (html && (contentType || "").includes("text/html")) {
          const $ = cheerio.load(html);
          const ctaRes = scoreCTA({ $, placePhone: false, placeHours: false });
          cta = ctaRes.cta; ctaBreakdown = ctaRes.ctaBreakdown; emergencyWords = ctaRes.emergencyHint;
          const seoRes = scoreSEO($);
          seo = seoRes.seo; seoBreakdown = seoRes.seoBreakdown;
        }
      }

      const emergencyMode = !!emergencyWords;
      const w = pickSiteWeights(businessType || tradeSelect, emergencyMode);
      const siteScore = Math.round(w.seo * seo + w.cta * cta);

      log({ stage: "site_only", reason: "no_gbp_match", siteScore, reachable, queryTried, centerUsed, latencyMs: Date.now() - t0 });

      return res.json({
        success: true,
        status: "SITE_ONLY",
        path: "SITE_ONLY",
        finalScore: siteScore,
        placeId: null,
        place: { name: businessName || null, address: null, website: providedWebsite },
        signals: {
          gbp: null,
          site: { seo, cta, siteWeights: w, reachable, checked: true, ctaBreakdown, seoBreakdown }
        },
        rationale: "No Google Business Profile located in the service area. Computed a provisional website-only score.",
        debug: { queryTried, centerUsed, ambiguous: null }
      });
    }

    // ---- If no GBP and no website → friendly guidance (no 4xx) ----
    if (!placeId && !providedWebsite) {
      log({ stage: "needs_input", queryTried, centerUsed, latencyMs: Date.now() - t0 });
      return res.json({
        success: true,
        status: "NEEDS_INPUT",
        path: "NO_GBP_NO_SITE",
        finalScore: null,
        signals: { gbp: null, site: null },
        rationale: "We couldn’t find a Google Business Profile and no website was provided.",
        actions: [
          "Provide a website URL (if any) to compute a provisional site-only score.",
          "Alternatively, claim/create the Google Business Profile and re-run analysis."
        ],
        debug: { queryTried, centerUsed, ambiguous: null }
      });
    }

    // ---- Place details (cached) ----
    const detailsKey = `details:${placeId}`;
    if (!bypassCache) details = cacheGet(detailsKey);
    if (!details) {
      const d = await mapsCall(gmaps.placeDetails, {
        params: {
          key: GOOGLE_MAPS_API_KEY_SERVER,
          place_id: placeId,
          fields: [
            "place_id","name","formatted_address","website","rating","user_ratings_total",
            "photos","formatted_phone_number","opening_hours","url","types","editorial_summary",
            "opening_hours.open_now"
          ],
        },
      });
      if (!d.ok) {
        log({ stage: "details_error", placeId, error: d.error });
        return res.status(502).json({ success: false, error: "place_details_failed", message: String(d.error), placeId });
      }
      details = d.data?.result || {};
      cacheSet(detailsKey, details, TTL_DETAILS_MS);
    }

    const officialWebsite = normalizeUrl(details.website || websiteUrl);
    const gbp = computeGbpScore(details, (businessType || tradeSelect || "").toLowerCase());
    const gbpSignalsPresent =
      Number(details?.rating) > 0 ||
      Number(details?.user_ratings_total) > 0 ||
      (Array.isArray(details?.photos) && details.photos.length > 0) ||
      !!details?.opening_hours;

    if (!gbpSignalsPresent && !officialWebsite) {
      log({ stage: "no_signals_gbp", placeId, latencyMs: Date.now() - t0 });
      return res.json({
        success: true,
        status: "NO_SIGNALS",
        path: "GBP_PRESENT_BUT_EMPTY",
        finalScore: null,
        signals: { gbp: gbp.subs, site: null },
        rationale: "GBP found but with no usable public signals, and no website supplied.",
        actions: ["Add a website URL or enrich GBP (photos, hours, collect initial reviews), then re-run."]
      });
    }

    // ---- Site path: probe + SEO/CTA (optional) ----
    let siteProbe = null, seo = 0, cta = 0, emergencyWords = false, seoBreakdown = {}, ctaBreakdown = {};
    if (officialWebsite) {
      siteProbe = await probeSite(officialWebsite, { timeoutMs: 4000 });
      const reachable = !!siteProbe.reachable;
      if (!fast && reachable) {
        const { html, contentType } = await fetchHtml(officialWebsite, 6000, !bypassCache);
        if (html && (contentType || "").includes("text/html")) {
          const $ = cheerio.load(html);
          const ctaRes = scoreCTA({ $, placePhone: !!details.formatted_phone_number, placeHours: !!details.opening_hours });
          cta = ctaRes.cta; ctaBreakdown = ctaRes.ctaBreakdown; emergencyWords = ctaRes.emergencyHint;
          const seoRes = scoreSEO($);
          seo = seoRes.seo; seoBreakdown = seoRes.seoBreakdown;
        }
      }
    }

    const emergencyMode = !!emergencyWords || !!details?.opening_hours?.open_now;
    const siteW = pickSiteWeights(businessType || tradeSelect, emergencyMode);
    const siteScore = Math.round(siteW.seo * seo + siteW.cta * cta);

    // ---- Adaptive final score (v1): GBP 60% / Site 40% if site reachable ----
    const useBlend = !!(officialWebsite && siteProbe?.checked && siteProbe.reachable);
    const path = useBlend ? "BLENDED_60_40" : "GBP_ONLY";
    const finalScore = Math.round(useBlend ? (0.6 * gbp.score + 0.4 * siteScore) : gbp.score);

    const mapEmbedUrl = makeMapEmbedUrl(placeId);

    log({
      stage: "done",
      placeId,
      path,
      gbpScore: gbp.score,
      siteScore,
      finalScore,
      queryTried, centerUsed,
      latencyMs: Date.now() - t0
    });

    return res.json({
      success: true,
      status: "OK",
      placeId,
      place: {
        name: details?.name,
        address: details?.formatted_address,
        website: officialWebsite || null,
        rating: details?.rating ?? null,
        user_ratings_total: details?.user_ratings_total ?? null,
        open_now: !!details?.opening_hours?.open_now,
      },
      path,
      finalScore,
      signals: {
        gbp: gbp.subs,
        site: {
          seo, cta, siteWeights: siteW,
          checked: !!siteProbe,
          reachable: !!(siteProbe && siteProbe.reachable),
          ctaBreakdown, seoBreakdown
        }
      },
      rationale: useBlend
        ? "Blended score: GBP signals + valid website checks."
        : (officialWebsite ? "Website not reachable within time limit — scored from GBP signals only." : "No website provided — scored from GBP signals only."),
      mapEmbedUrl,
      debug: { ambiguous, queryTried, centerUsed }
    });
  } catch (err) {
    const msg = String(err?.response?.data?.error_message || err?.message || err);
    const code = err?.response?.status || 500;
    const isQuota = /quota|over|exceeded|429/i.test(msg);
    const errorCode = isQuota ? "api_quota" : code === 403 ? "forbidden" : "server_error";
    console.error(JSON.stringify({ at: "analyze", stage: "catch", code, error: msg }));
    return res.status(isQuota ? 429 : code).json({ success: false, error: errorCode, message: msg });
  }
});

// ---------- Competitive Snapshot (no scraping) ----------
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

app.post("/api/competitive-snapshot", async (req, res) => {
  try {
    const { placeId, trade, area } = req.body || {};
    const bypassCache = noCache(req);

    // Geometry bias
    let locationBias = null;
    if (placeId) {
      const dKey = `geom:${placeId}`;
      let geom = bypassCache ? null : cacheGet(dKey);
      if (!geom) {
        const dRes = await mapsCall(gmaps.placeDetails, {
          params: { key: GOOGLE_MAPS_API_KEY_SERVER, place_id: placeId, fields: ["geometry", "name"] },
        });
        if (dRes.ok) {
          const g = dRes.data?.result?.geometry?.location;
          geom = g?.lat && g?.lng ? { lat: g.lat, lng: g.lng } : null;
          if (geom) cacheSet(dKey, geom, TTL_DETAILS_MS);
        }
      }
      if (geom) locationBias = geom;
    }

    const base = tradeToQuery(trade);
    const query = area ? `${base} ${area}` : base;

    const tsKey = `textsearch:${query}:${locationBias ? `${locationBias.lat},${locationBias.lng}` : "x"}`;
    let basics = bypassCache ? null : cacheGet(tsKey);
    if (!basics) {
      const tsRes = await mapsCall(gmaps.textSearch, {
        params: {
          key: GOOGLE_MAPS_API_KEY_SERVER,
          query,
          type: "establishment",
          ...(locationBias ? { location: locationBias, radius: 15000 } : {}),
        },
      });
      if (!tsRes.ok) return res.status(502).json({ success: false, error: `textSearch failed: ${tsRes.error}` });
      basics = (tsRes.data?.results || []).slice(0, 10);
      cacheSet(tsKey, basics, TTL_DETAILS_MS);
    }

    const enriched = [];
    for (const b of basics) {
      const eKey = `details:${b.place_id}`;
      let r = bypassCache ? null : cacheGet(eKey);
      if (!r) {
        const dRes = await mapsCall(gmaps.placeDetails, {
          params: {
            key: GOOGLE_MAPS_API_KEY_SERVER,
            place_id: b.place_id,
            fields: ["place_id", "name", "formatted_address", "rating", "user_ratings_total", "photos", "website"],
          },
        });
        if (dRes.ok) {
          r = dRes.data?.result || {};
          cacheSet(eKey, r, TTL_DETAILS_MS);
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
    console.error(JSON.stringify({ at: "competitive", error: String(err?.message || err) }));
    res.status(500).json({ success: false, error: "Failed to fetch competitors", details: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Elev8Trades backend running on port ${PORT} [${NODE_ENV}]`);
});
