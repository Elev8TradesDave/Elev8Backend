/* ==============================================================
   widget.js – FINAL POLISHED VERSION
   - Clarification flex renderer
   - Trade → businessType (case-insensitive)
   - URL prefill from QR/query params
   - Auto-fast mode when no website
   - Full helper fallbacks
   - Accessible clarifications
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
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (error) {
    throw error;
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
  const specialty = ["roofing", "plumbing", "electrical", "hvac"];
  return specialty.includes(t) ? "specialty" : "maintenance";
}

/* ------------------- Prefill from URL (QR, ads) ---------------- */
(function prefillFromQuery() {
  const p = new URLSearchParams(location.search);
  if (p.has("trade")) $("tradeSelect").value = p.get("trade");
  if (p.has("area")) $("area").value = p.get("area");
  if (p.has("name")) $("bName").value = p.get("name");
  if (p.has("url")) $("webUrl").value = normUrlMaybe(p.get("url"));
  // Auto-enable Fast mode if no website
  if (!$("webUrl").value.trim()) $("fast").checked = true;
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

function renderClarificationsFlex(clar) {
  const wrap = $("clarWrap");
  const msgEl = $("clarMsg");
  const list = $("clarList");
  clearClarifications();

  // Normalize input
  const clarArr = Array.isArray(clar) ? clar : [clar || {}];
  const messages = [];
  let candidates = [];

  clarArr.forEach(item => {
    if (item?.message) messages.push(item.message);
    if (Array.isArray(item?.candidates)) {
      candidates = candidates.concat(item.candidates);
    }
  });

  // Show message
  if (msgEl) {
    const msg = messages.length ? messages.join(" ") : "Multiple matches found. Please select one.";
    msgEl.textContent = msg;
    msgEl.setAttribute("aria-live", "polite");
  }

  // Render up to 8 candidates
  candidates.slice(0, 8).forEach(c => {
    const btn = document.createElement("button");
    btn.className = "clar-btn";
    btn.textContent = `${c.name || "Unnamed"} — ${c.formatted_address || "No address"}`;
    btn.onclick = () => analyzeWithPlaceId(c.place_id, c.name, c.formatted_address);
    btn.setAttribute("aria-label", `Select ${c.name}`);
    list?.appendChild(btn);
  });

  // No matches hint
  if (candidates.length === 0) {
    const hint = document.createElement("div");
    hint.className = "clar-hint";
    hint.textContent = "No exact matches. Try adding city/state, shortening the name, or using the website URL.";
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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = await res.json();

    if (!data.success) {
      setText("details", `Error: ${data.error || "Unknown error"}`);
      disableButtons(false);
      return;
    }

    if (data.clarifications) {
      renderClarificationsFlex(data.clarifications);
      disableButtons(false);
      return;
    }

    renderScoring(data);
    lastPlaceId = data.placeId || null;
    await competitors(lastPlaceId, body.tradeSelect, body.serviceArea);

  } catch (e) {
    const msg = e.name === "AbortError" ? "Request timed out." : e.message;
    setText("details", `Request failed: ${msg}`);
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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

    const data = await res.json();

    if (!data.success) {
      setText("details", `Error: ${data.error || "Unknown"}`);
      return;
    }

    renderScoring(data);
    lastPlaceId = data.placeId || placeId || null;
    await competitors(lastPlaceId, $("tradeSelect").value.trim(), $("area").value.trim());

  } catch (e) {
    const msg = e.name === "AbortError" ? "Request timed out." : e.message;
    setText("details", `Request failed: ${msg}`);
  } finally {
    disableButtons(false);
  }
}

/* ----------------------- Render Scoring ----------------------- */
function renderScoring(data) {
  setBar("overallBar", data.finalScore || 0);
  setText("overallPct", (data.finalScore ?? "—") + " / 100");
  setText("modeBadge", data.mode || "—");

  const ds = data.detailedScores || {};
  setBar("barSeo", ds["On-Page SEO"] ?? data.seo ?? 0);
  setText("valSeo", ds["On-Page SEO"] ?? data.seo ?? "—");
  setBar("barCta", ds["Call-to-Action Strength"] ?? data.cta ?? 0);
  setText("valCta", ds["Call-to-Action Strength"] ?? data.cta ?? "—");
  setBar("barGbp", ds["Overall Rating"] ?? data.gbp ?? 0);
  setText("valGbp", ds["Overall Rating"] ?? data.gbp ?? "—");

  const reviews = ds["Review Volume"] ?? data?.dials?.reviews ?? null;
  const pain = ds["Pain Point Resonance"] ?? data?.dials?.pain ?? null;
  setBar("barReviews", reviews || 0);
  setText("valReviews", reviews ?? "—");
  setBar("barPain", pain || 0);
  setText("valPain", pain ?? "—");

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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HTTP ${res.status}: ${err}`);
    }

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
    const msg = e.name === "AbortError" ? "Timed out" : e.message;
    setText("competitors", `Request failed: ${msg}`);
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