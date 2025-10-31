/* ==============================================================
   widget.js – FINAL POLISHED (r3)
   - Clarification array/object support
   - Competitors via backend Maps API
   - Trade → businessType mapping
   - Prefer detailedScores; graceful fallbacks
   - Stronger hint when no candidates returned
   ============================================================== */
const $ = id => document.getElementById(id);
const API = path => (window.LVA_API_BASE || "") + path;

/* --------------------------- Helpers --------------------------- */
function setBar(id, value) {
  const el = $(id);
  if (!el) return;
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  el.style.width = v + "%";
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = (text ?? "").toString();
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normUrlMaybe(u) {
  if (!u) return "";
  const s = u.trim();
  return /^https?:\/\//i.test(s) ? s : "https://" + s;
}

function deriveBusinessType(trade) {
  const t = (trade || "").toLowerCase().trim();
  const specialty = ["roofing", "plumbing", "electrical", "hvac", "hvac (repair)", "hvac (install)", "masonry"];
  return specialty.some(k => t.includes(k.replace(/\s*\(.*?\)\s*/g, ""))) ? "specialty" : "maintenance";
}

/* ------------------- Prefill from URL (QR, ads) ---------------- */
(function prefillFromQuery() {
  const p = new URLSearchParams(location.search);
  if (p.has("trade")) $("tradeSelect").value = p.get("trade");
  if (p.has("area")) $("area").value = p.get("area");
  if (p.has("name")) $("bName").value = p.get("name");
  if (p.has("url")) $("webUrl").value = normUrlMaybe(p.get("url"));
  if (!$("webUrl").value.trim()) $("fast").checked = true; // Auto-fast if no site
})();

/* ------------------- Clarification UI (Flexible) --------------- */
function clearClarifications() {
  const wrap = $("clarWrap");
  const msgEl = $("clarMsg");
  const list = $("clarList");
  wrap?.classList.remove("show");
  if (msgEl) msgEl.textContent = "";
  if (list) list.innerHTML = "";
}

function renderClarificationsFlex(clarInput) {
  const wrap = $("clarWrap");
  const msgEl = $("clarMsg");
  const list = $("clarList");
  clearClarifications();

  // Accept object or array; flatten to {message[], candidates[]}
  const clarArr = Array.isArray(clarInput) ? clarInput : [clarInput || {}];
  const messages = [];
  let candidates = [];

  for (const item of clarArr) {
    if (item?.message) messages.push(item.message);
    if (Array.isArray(item?.candidates)) candidates = candidates.concat(item.candidates);
  }

  // Message
  if (msgEl) {
    const msg = messages.length
      ? messages.join(" ")
      : (candidates.length ? "Multiple matches found. Please select one." : "No exact matches.");
    msgEl.textContent = msg;
    msgEl.setAttribute("aria-live", "polite");
  }

  // Candidates (max 8)
  (candidates || []).slice(0, 8).forEach(c => {
    const btn = document.createElement("button");
    btn.className = "clar-btn";
    btn.textContent = `${c.name || "Unnamed"} — ${c.formatted_address || "No address"}`;
    btn.onclick = () => analyzeWithPlaceId(c.place_id, c.name, c.formatted_address);
    btn.setAttribute("aria-label", `Select ${c.name}`);
    list?.appendChild(btn);
  });

  // Stronger hint when empty
  if (!candidates || candidates.length === 0) {
    const hint = document.createElement("div");
    hint.className = "clar-hint";
    hint.textContent =
      "No exact matches. Try adding a city/state, shortening the name, pasting the website URL, or trying a broader search (e.g., just the brand + state).";
    list?.appendChild(hint);
  }

  wrap?.classList.add("show");
}

/* ----------------------- Button Control ----------------------- */
function disableButtons(disabled = true) {
  $("btnAnalyze")?.toggleAttribute("disabled", disabled);
  $("btnCompetitors")?.toggleAttribute("disabled", disabled);
}

/* -------------------------- Analysis -------------------------- */
let lastPlaceId = null;

async function analyze() {
  clearClarifications();
  disableButtons(true);

  const body = {
    businessName: $("bName").value.trim(),
    websiteUrl: $("webUrl").value.trim(),
    serviceArea: $("area").value.trim(),
    tradeSelect: $("tradeSelect").value.trim(),
    fast: $("fast").checked,
  };

  if (body.websiteUrl) body.websiteUrl = normUrlMaybe(body.websiteUrl);
  body.businessType = deriveBusinessType(body.tradeSelect);

  if (!body.businessName) {
    setText("details", "Please enter a business name.");
    disableButtons(false);
    return;
  }

  setText("details", "Analyzing…");
  setText("competitors", "—");
  $("mapEmbedWrap").style.display = "none";

  try {
    const res = await fetchWithTimeout(API("/api/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 15000);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (!data.success) {
      setText("details", `Error: ${data.error || "Unknown error"}`);
      return;
    }

    if (data.clarifications) {
      renderClarificationsFlex(data.clarifications);
      return;
    }

    renderScoring(data);
    lastPlaceId = data.placeId || null;

    // Real competitor search via backend (Maps TextSearch/Details)
    await competitors(lastPlaceId, body.tradeSelect, body.serviceArea);

  } catch (e) {
    setText("details", `Request failed: ${e.name === "AbortError" ? "Request timed out." : e.message}`);
  } finally {
    disableButtons(false);
  }
}

async function analyzeWithPlaceId(placeId, name, address) {
  clearClarifications();
  disableButtons(true);

  const body = {
    businessName: $("bName").value.trim() || name || "",
    websiteUrl: $("webUrl").value.trim(),
    serviceArea: $("area").value.trim() || address || "",
    tradeSelect: $("tradeSelect").value.trim(),
    fast: $("fast").checked,
    placeId,
    businessType: deriveBusinessType($("tradeSelect").value.trim()),
  };
  if (body.websiteUrl) body.websiteUrl = normUrlMaybe(body.websiteUrl);

  setText("details", "Analyzing selected place…");
  setText("competitors", "—");
  $("mapEmbedWrap").style.display = "none";

  try {
    const res = await fetchWithTimeout(API("/api/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 15000);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (!data.success) {
      setText("details", `Error: ${data.error || "Unknown"}`);
      return;
    }

    renderScoring(data);
    lastPlaceId = data.placeId || placeId || null;
    await competitors(lastPlaceId, $("tradeSelect").value.trim(), $("area").value.trim());

  } catch (e) {
    setText("details", `Request failed: ${e.name === "AbortError" ? "Request timed out." : e.message}`);
  } finally {
    disableButtons(false);
  }
}

/* ----------------------- Render Scoring ----------------------- */
function renderScoring(data) {
  // Prefer detailedScores if present
  const ds = data.detailedScores || {};
  const seoVal = (ds["On-Page SEO"] ?? data.seo ?? 0);
  const ctaVal = (ds["Call-to-Action Strength"] ?? data.cta ?? 0);
  const gbpVal = (ds["Overall Rating"] ?? data.gbp ?? 0);
  const reviewsDial = (ds["Review Volume"] ?? data?.dials?.reviews ?? null);
  const painDial = (ds["Pain Point Resonance"] ?? data?.dials?.pain ?? null);

  setBar("overallBar", data.finalScore || 0);
  setText("overallPct", (data.finalScore ?? "—") + " / 100");
  setText("modeBadge", data.mode || "—");

  setBar("barSeo", seoVal);  setText("valSeo", seoVal ?? "—");
  setBar("barCta", ctaVal);  setText("valCta", ctaVal ?? "—");
  setBar("barGbp", gbpVal);  setText("valGbp", gbpVal ?? "—");

  setBar("barReviews", reviewsDial || 0);
  setText("valReviews", reviewsDial ?? "—");
  setBar("barPain", painDial || 0);
  setText("valPain", painDial ?? "—");

  if (data.mapEmbedUrl) {
    $("mapEmbed").src = data.mapEmbedUrl;
    $("mapEmbedWrap").style.display = "block";
  } else {
    $("mapEmbedWrap").style.display = "none";
  }

  const det = {
    placeId: data.placeId,
    place: data.place,
    mode: data.mode,
    weightsUsed: data.weightsUsed,
    seoBreakdown: data.seoBreakdown,
    ctaBreakdown: data.ctaBreakdown,
    detailedScores: ds,
  };
  setText("details", JSON.stringify(det, null, 2));
}

/* ------------------------- Competitors ------------------------- */
async function competitors(placeId, trade, area) {
  if (!trade && !area && !placeId) {
    setText("competitors", "Provide a trade or area (or run Analyze first).");
    return;
  }

  setText("competitors", "Fetching competitors…");

  try {
    const res = await fetchWithTimeout(API("/api/competitive-snapshot"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placeId, trade, area }),
    }, 15000);

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (!data.success) {
      setText("competitors", `Error: ${data.error || "Unknown"}`);
      return;
    }

    const out = {
      query: data.queryUsed,
      biasedBy: data.biasedBy,
      competitors: data.competitors,
      adIntel: data.adIntel,
    };
    setText("competitors", JSON.stringify(out, null, 2));

  } catch (e) {
    setText("competitors", `Request failed: ${e.name === "AbortError" ? "Timed out" : e.message}`);
  }
}

/* -------------------------- Wiring --------------------------- */
$("btnAnalyze")?.addEventListener("click", analyze);
$("btnCompetitors")?.addEventListener("click", () =>
  competitors(lastPlaceId, $("tradeSelect").value.trim(), $("area").value.trim())
);
$("btnTop")?.addEventListener("click", () =>
  window.scrollTo({ top: 0, behavior: "smooth" })
);
