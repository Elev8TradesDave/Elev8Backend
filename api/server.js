/**
 * Elev8Trades Backend (Render-friendly)
 * Paths: SITE_ONLY / SITE_ONLY_FORCED / GBP_ONLY / BLENDED_60_40 / NEEDS_INPUT
 * SAB-aware place resolution; candidate picker; health route; caching; rate limits; CSP; competitors.
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const { Client } = require("@googlemaps/google-maps-services-js");

// ===== Env / Startup guards =====
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

// Fail fast if critical server keys are missing
if (!process.env.GOOGLE_MAPS_API_KEY_SERVER) {
  console.error("FATAL: GOOGLE_MAPS_API_KEY_SERVER secret missing");
  process.exit(1);
}
if (!process.env.GOOGLE_MAPS_EMBED_KEY) {
  console.warn("WARN: GOOGLE_MAPS_EMBED_KEY missing — map embed previews will be disabled.");
}

// Assert native fetch (Node 20+) for maximum reliability under load
if (typeof fetch !== "function") {
  console.error(
    "FATAL: Native fetch not available. Please run on Node 20+ (Render currently uses Node 22)."
  );
  process.exit(1);
}

if (process.env.GEMINI_API_KEY && !IS_PRODUCTION) {
  console.log("[info] Gemini key detected (not used yet).");
}

const app = express();

// ===== Security headers (minimal CSP + COEP off to allow Google maps) =====
app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": [
          "'self'",
          "data:",
          "https:",
          "https://maps.gstatic.com",
          "https://maps.googleapis.com",
        ],
        "frame-src": ["'self'", "https://www.google.com"],
        "connect-src": ["'self'"],
      },
    },
  })
);

// ===== JSON / Compression =====
app.use(express.json({ limit: "1mb" }));
app.use(compression());

// ===== Static assets (serve widget.js, images, etc.) =====
app.use(
  express.static(process.cwd(), {
    index: false,      // we explicitly serve "/" below
    fallthrough: true,
    extensions: ["html"]
  })
);

// ===== CORS (tight whitelist — replace with your real domain[s]) =====
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://elev8trades.com",
  "https://widget.elev8trades.com",
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / curl / same-origin OK
      const ok = ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
      return cb(null, ok);
    },
  })
);

// ===== Rate limiting =====
app.use(
  rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false })
);
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
});
const competitorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

// ===== Serve widget from root and explicit path (for QR deep-link) =====
app.get("/", (_req, res) => res.sendFile(path.join(process.cwd(), "widget.html")));
app.get("/widget.html", (_req, res) => res.sendFile(path.join(process.cwd(), "widget.html")));

// ===== In-memory TTL cache =====
const _cache = new Map();
const now = () => Date.now();
function cacheSet(key, val, ttlMs = 6 * 60 * 60 * 1000) {
  _cache.set(key, { v: val, exp: now() + ttlMs });
}
function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.exp < now()) {
    _cache.delete(key);
    return null;
  }
  return hit.v;
}
function noCache(req) {
  return !!req.query?.nocache || !!req.body?.nocache;
}

// ===== Google Maps client =====
const maps = new Client({});
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY_SERVER;
const EMBED_KEY = process.env.GOOGLE_MAPS_EMBED_KEY;

// ===== Helpers =====
function trimStr(x) {
  return String(x || "").trim();
}
function normalizeUrl(u) {
  if (!u) return "";
  let s = trimStr(u);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/\/+$/, "/");
  return s;
}

async function probeSite(url, timeoutMs = 7000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctl.signal });
    clearTimeout(t);
    if (res.ok || (res.status >= 200 && res.status < 400)) return { ok: true, status: res.status };
    return { ok: false, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function fetchHtml(url, timeoutMs = 8000) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { redirect: "follow", signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function extractSiteSignals(html) {
  const out = { titleLen: 0, hasMetaDesc: false, telCount: 0, h1Count: 0, ctaBonus: 0 };
  if (!html) return out;
  const titleMatch = html.match(/<title[^>]*>([^<]{0,300})<\/title>/i);
  out.titleLen = titleMatch ? trimStr(titleMatch[1]).length : 0;
  out.hasMetaDesc = /<meta[^>]+name=["']description["'][^>]*>/i.test(html);
  const telMatches = html.match(/href\s*=\s*["']\s*tel:/gi);
  out.telCount = telMatches ? telMatches.length : 0;
  const h1Matches = html.match(/<h1\b[^>]*>/gi);
  out.h1Count = h1Matches ? h1Matches.length : 0;
  const extra = Math.max(0, out.telCount - 1) * 2;
  out.ctaBonus = Math.min(10, extra);
  return out;
}

function scoreWebsite(signals, reachable) {
  let base = 20;
  if (signals.titleLen >= 10) base += 10;
  if (signals.titleLen >= 30) base += 10;
  if (signals.hasMetaDesc) base += 10;
  if (signals.h1Count >= 1) base += 10;
  base += signals.ctaBonus; // up to +10
  if (!reachable) base -= 30;
  return Math.max(0, Math.min(100, Math.round(base)));
}

function volumePctFromReviews(reviews) {
  if (reviews >= 100) return 100;
  if (reviews >= 50) return 85;
  if (reviews >= 20) return 70;
  if (reviews >= 5) return 50;
  return 20;
}

function scoreGBP(details, businessType) {
  const out = { ratingPct: 0, volumePct: 0, categoryPct: 0, photosPct: 0, hoursPct: 0 };
  if (!details) return { gbpScore: 0, ...out };

  const rating = details.rating || 0;
  const reviews = details.user_ratings_total || 0;
  const cats = (details.types || []).map((t) => String(t).toLowerCase());
  const photos = Array.isArray(details.photos) ? details.photos.length : (details.photos || []).length;
  const hasHours = !!(details.opening_hours && typeof details.opening_hours.open_now === "boolean");

  out.ratingPct = Math.round((rating / 5) * 100);
  out.volumePct = volumePctFromReviews(reviews);
  const bt = String(businessType || "").toLowerCase().trim();
  out.categoryPct = bt ? (cats.some((c) => c.includes(bt)) ? 100 : 50) : 60;
  out.photosPct = Math.max(0, Math.min(100, photos * 5));
  out.hoursPct = hasHours ? 80 : 40;

  const gbpScore = Math.round(
    0.35 * out.ratingPct +
      0.25 * out.volumePct +
      0.15 * out.categoryPct +
      0.15 * out.photosPct +
      0.1 * out.hoursPct
  );

  return { gbpScore, ...out };
}

function mapEmbedUrl(placeId) {
  if (!EMBED_KEY || !placeId) return "";
  return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(
    EMBED_KEY
  )}&q=place_id:${encodeURIComponent(placeId)}`;
}

function mapsPlaceLink(placeId) {
  return `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(
    placeId
  )}`;
}

// Expand name variants: remove suffixes, prefixes, punctuation
function expandNameVariants(name) {
  const set = new Set();
  const cleanTail = (s) =>
    String(s || "")
      .replace(/[,.\s]+$/g, "")
      .replace(/^(the|a)\s+/i, "")
      .replace(/\s*&\s*sons\b/i, "")
      .trim();
  const base = cleanTail(name);
  if (!base) return [];
  set.add(base);
  set.add(cleanTail(base.replace(/\b(inc|llc|ltd)\.?$/i, "")));
  set.add(cleanTail(base.replace(/\b(inc\.?|llc\.?|ltd\.?)\b/gi, "")));
  set.add(cleanTail(base.replace(/\s+co(mpany)?\.?$/i, "")));
  return Array.from(set).filter(Boolean);
}

// crude name similarity (token overlap + length proximity)
function nameSimilarity(a, b) {
  const A = String(a || "").toLowerCase();
  const B = String(b || "").toLowerCase();
  if (!A || !B) return 0;
  const at = new Set(A.split(/\s+/).filter(Boolean));
  const bt = new Set(B.split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  const lenScore = 1 - Math.min(1, Math.abs(A.length - B.length) / Math.max(A.length, B.length));
  return overlap * 2 + lenScore; // simple weighted sum
}

// SAB-aware place resolution (Text Search) — collect from all queries, then pick best
async function resolvePlace({ businessName, businessType, serviceArea }, { bypassCache }) {
  const name = trimStr(businessName);
  const area = trimStr(serviceArea);
  const bt = trimStr(businessType);
  if (!name && !area) return { ok: false, status: "NEEDS_INPUT" };

  const variants = expandNameVariants(name);
  const queries = (variants.length ? variants : [name || bt])
    .map((q) => [q, bt || "", area || ""].filter(Boolean).join(" "));

  const cacheKey = `place:${queries.join("|")}`;
  if (!bypassCache) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const candidates = [];

  for (const q of queries) {
    try {
      const resp = await maps.textSearch({
        params: { key: MAPS_KEY, query: q, region: "us" },
        timeout: 8000,
      });
      const results = resp?.data?.results || [];
      for (const r of results) {
        candidates.push({
          placeId: r.place_id,
          name: r.name,
          formatted_address: r.formatted_address,
          rating: r.rating,
          user_ratings_total: r.user_ratings_total,
        });
      }
    } catch {
      /* continue */
    }
  }

  if (candidates.length === 0) {
    const out = { ok: false, status: "AMBIGUOUS", candidates: [] };
    cacheSet(cacheKey, out, 3 * 60 * 60 * 1000);
    return out;
  }

  // Best candidate: similarity -> strength -> reviews (tie-breaker)
  const scored = candidates.map((c) => ({
    ...c,
    _sim: nameSimilarity(name, c.name),
    _strength: (c.rating || 0) * 20 + Math.min(100, c.user_ratings_total || 0),
  }));
  scored.sort(
    (a, b) =>
      b._sim - a._sim ||
      b._strength - a._strength ||
      (b.user_ratings_total || 0) - (a.user_ratings_total || 0)
  );
  const winner = scored[0];

  const out = {
    ok: true,
    placeId: winner.placeId,
    candidates: scored.map(({ _sim, _strength, ...r }) => r),
  };
  cacheSet(cacheKey, out, 3 * 60 * 60 * 1000);
  return out;
}

// ===== Small concurrency helper =====
async function runWithLimit(limit, tasks) {
  const results = new Array(tasks.length);
  let i = 0,
    active = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (i === tasks.length && active === 0) return resolve(results);
      while (active < limit && i < tasks.length) {
        const idx = i++;
        active++;
        Promise.resolve()
          .then(tasks[idx])
          .then((val) => {
            results[idx] = val;
          })
          .catch(() => {
            results[idx] = null;
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

// ===== Routes =====

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    env: NODE_ENV,
    hasServerKey: !!process.env.GOOGLE_MAPS_API_KEY_SERVER,
    hasEmbedKey: !!process.env.GOOGLE_MAPS_EMBED_KEY,
  });
});

app.post("/api/analyze", analyzeLimiter, async (req, res) => {
  try {
    const {
      businessName,
      businessType,
      serviceArea,
      websiteUrl: rawUrl,
      placeId: overridePlaceId,
      fast,
      siteOnly,
    } = req.body || {};

    const bypassCache = noCache(req);
    const forceSiteOnly = siteOnly === true || siteOnly === 1;

    // Normalize/probe site
    const siteUrl = normalizeUrl(rawUrl);
    const siteProbe = siteUrl ? await probeSite(siteUrl) : { ok: false };

    // Resolve place unless forced site-only
    let placeId = null;
    let candidates = [];
    if (!forceSiteOnly) {
      if (overridePlaceId) {
        placeId = trimStr(overridePlaceId) || null;
      } else {
        const resolved = await resolvePlace(
          { businessName, businessType, serviceArea },
          { bypassCache }
        );
        if (resolved.ok) {
          placeId = resolved.placeId;
          candidates = resolved.candidates || [];
        } else if (resolved.candidates?.length) {
          return res.status(200).json({
            success: false,
            status: "NEEDS_INPUT",
            message: "Pick a candidate or provide a service area.",
            candidates: resolved.candidates,
          });
        }
      }
    }

    // Details (cached)
    let details = null;
    if (placeId) {
      const k = `details:${placeId}`;
      details = bypassCache ? null : cacheGet(k);
      if (!details) {
        const d = await maps.placeDetails({
          params: {
            key: MAPS_KEY,
            place_id: placeId,
            fields: [
              "place_id",
              "name",
              "rating",
              "user_ratings_total",
              "types",
              "opening_hours",
              "photos",
              "website",
            ],
          },
          timeout: 8000,
        });
        details = d?.data?.result || null;
        if (details) cacheSet(k, details, 12 * 60 * 60 * 1000);
      }
    }

    // Site score (fetch HTML only if reachable and not fast)
    let siteScore = 0,
      siteSignals = null;
    if (siteUrl && (siteProbe.ok || !fast)) {
      const htmlRes = siteProbe.ok && !fast ? await fetchHtml(siteUrl) : { ok: false };
      siteSignals = htmlRes.ok ? extractSiteSignals(htmlRes.text) : extractSiteSignals("");
      siteScore = scoreWebsite(siteSignals, !!siteProbe.ok);
    }

    // GBP score
    const { gbpScore, ratingPct, volumePct, categoryPct, photosPct, hoursPct } = scoreGBP(
      details,
      businessType
    );

    // Path / status / final
    let status = "OK";
    let path = "BLENDED_60_40";
    let finalScore = 0;
    let ceiling = false;

    if (forceSiteOnly) {
      status = "SITE_ONLY_FORCED";
      path = "SITE_ONLY";
      finalScore = siteScore;
      ceiling = true;
    } else if (!placeId && siteUrl) {
      status = "SITE_ONLY";
      path = "SITE_ONLY";
      finalScore = siteScore;
      ceiling = true;
    } else if (placeId && (!siteUrl || !siteProbe.ok)) {
      status = "GBP_ONLY";
      path = "GBP_ONLY";
      finalScore = gbpScore;
      ceiling = !siteUrl || !siteProbe.ok;
    } else if (placeId && siteUrl) {
      status = "BLENDED_60_40";
      path = "BLENDED_60_40";
      finalScore = Math.round(0.6 * gbpScore + 0.4 * siteScore);
      ceiling = gbpScore < 60 || !siteProbe.ok;
    } else {
      status = "NEEDS_INPUT";
      path = "NEEDS_INPUT";
      finalScore = 0;
    }

    res.json({
      success: true,
      status,
      path,
      finalScore,
      ceiling,
      rationale:
        status === "SITE_ONLY" || status === "SITE_ONLY_FORCED"
          ? "Provisional website-only score. Add/claim your Google Business Profile to raise the ceiling."
          : status === "GBP_ONLY"
          ? "GBP signals only (website missing or unreachable). Add/repair your website to raise the ceiling."
          : "Adaptive blend of GBP (60%) and site (40%).",
      placeId: placeId || null,
      mapEmbedUrl: placeId ? mapEmbedUrl(placeId) : "",
      candidates,
      gbp: {
        gbpScore,
        ratingPct,
        volumePct,
        categoryPct,
        photosPct,
        hoursPct,
        rating: details?.rating || 0,
        user_ratings_total: details?.user_ratings_total || 0,
      },
      site: { siteUrl, reachable: !!siteProbe.ok, siteScore, signals: siteSignals },
    });
  } catch (err) {
    if (!IS_PRODUCTION) console.error("Analyze error:", err);
    res.status(500).json({ success: false, error: "Internal error" });
  }
});

/**
 * GET /api/competitive-snapshot
 * Params:
 *   ?businessName=...&serviceArea=...&businessType=... (preferred)
 *   or ?businessType=...&serviceArea=... (also accepts ?trade / ?area)
 * Optional: ?nocache=1
 */
app.get("/api/competitive-snapshot", competitorLimiter, async (req, res) => {
  try {
    const businessName = trimStr(req.query.businessName);
    const serviceArea = trimStr(req.query.serviceArea || req.query.area);
    const businessType = trimStr(req.query.businessType || req.query.trade);

    const trade = businessType;
    const area = serviceArea;
    const bypassCache = !!req.query?.nocache;

    if (!trade || !area) {
      return res.status(400).json({ ok: false, error: "Missing ?businessType and/or ?serviceArea" });
    }

    const MAX_COMPETITORS = 6;
    const COMP_TTL = 60 * 60 * 1000; // 1h

    const cacheKey = `comp:${businessName}:${trade}:${area}`;
    if (!bypassCache) {
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
    }

    // 1) Search for competitors
    const searchQuery = `${trade} in ${area}`;
    const ts = await maps.textSearch({
      params: { key: MAPS_KEY, query: searchQuery, region: "us" },
      timeout: 10000,
    });
    let results = ts?.data?.results || [];

    // optional self-exclusion (use similarity to catch variants)
    if (businessName) {
      results = results.filter((r) => nameSimilarity(businessName, r.name || "") < 3);
    }

    const ranked = results
      .map((r) => ({
        place_id: r.place_id,
        name: r.name,
        rating: r.rating || 0,
        user_ratings_total: r.user_ratings_total || 0,
        formatted_address: r.formatted_address,
      }))
      .sort((a, b) => b.rating - a.rating || b.user_ratings_total - a.user_ratings_total)
      .slice(0, MAX_COMPETITORS);

    // 2) Enrich details with concurrency limit
    const tasks = ranked.map((r) => async () => {
      try {
        const det = await maps.placeDetails({
          params: {
            key: MAPS_KEY,
            place_id: r.place_id,
            fields: [
              "place_id",
              "name",
              "rating",
              "user_ratings_total",
              "formatted_address",
              "opening_hours",
              "website",
              "types",
              "photos",
            ],
          },
          timeout: 8000,
        });
        const d = det?.data?.result || {};
        const photosCount = Array.isArray(d.photos) ? d.photos.length : 0;

        return {
          placeId: d.place_id,
          name: d.name,
          rating: d.rating || 0,
          reviews: d.user_ratings_total || 0,
          address: d.formatted_address || "",
          openNow:
            d.opening_hours && typeof d.opening_hours.open_now === "boolean"
              ? d.opening_hours.open_now
              : null,
          website: d.website || "",
          types: Array.isArray(d.types) ? d.types : [],
          photosCount,
          mapsLink: mapsPlaceLink(d.place_id),
        };
      } catch {
        return null;
      }
    });

    const itemsRaw = await runWithLimit(2, tasks);
    const items = itemsRaw.filter(Boolean);

    // 3) Rank by GBP score (from actual details)
    const scored = items
      .map((it) => {
        const dLike = {
          rating: it.rating,
          user_ratings_total: it.reviews,
          types: it.types,
          opening_hours: { open_now: it.openNow },
          photos: new Array(it.photosCount || 0).fill(0),
        };
        const { gbpScore } = scoreGBP(dLike, trade);
        return { ...it, gbpScore };
      })
      .sort((a, b) => b.gbpScore - a.gbpScore)
      .map((c, i) => ({ ...c, rank: i + 1 }));

    const payload = {
      ok: true,
      trade,
      area,
      total: scored.length,
      cached: false,
      items: scored,
    };
    cacheSet(cacheKey, payload, COMP_TTL);
    res.json(payload);
  } catch (e) {
    if (!IS_PRODUCTION) console.error("Competitive snapshot error:", e);
    res.status(500).json({ ok: false, error: "Competitive snapshot failed" });
  }
});

// Quiet favicon
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Start
app.listen(PORT, () => {
  if (!IS_PRODUCTION) console.log(`[dev] Listening on http://localhost:${PORT}`);
});
