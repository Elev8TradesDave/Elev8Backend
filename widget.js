/* ==============================================================
   widget.js — FINAL
   - Clarifications: supports object OR array
   - Competitors: Maps Text Search + Details via backend
   - Trade mapping -> businessType (for server-side heuristics)
   - Uses data.detailedScores when present
   - Helpful no-match hint
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
    return await fetch(resource, { ...options, signal: controller.signal });
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
  const specialty = ["roofing", "plumbing", "electrical", "hvac", "hvac (repair)", "hvac (install)"];
  return specialty.some(x => t.includes(x.split(" ")[0])) ? "specialty" : "maintenance";
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
  $("clarWrap")?.classList.remove("show");
  setText("clarMsg", "");
  $("clarList") && ( $("clarList").innerHTML = "" );
  setText("clarHint", "");
}
function renderClarificationsFlex(clar) {
  const wrap = $("clarWrap");
  const list = $("clarList");
  clearClarifications();

  const clarArr = Array.isArray(clar) ? clar : [clar || {}];

  // Merge possible multiple payloads
  const messages = [];
  let candidates = [];
  clarArr.forEach(item => {
    if (item?.message) messages.push(item.message);
    if (Array.isArray(item?.candidates)) candidates = candidates.concat(item.candidates);
  });

  setText("clarMsg", messages.length ? messages.join(" ") : "Multiple matches found. Please select one.");

  candidates.slice(0, 8).forEach(c => {
    const btn = document.createElement("button");
    btn.className = "clar-btn";
    btn.textContent = `${c.name || "Unnamed"} — ${c.formatted_address || "No address"}`;
    btn.onclick = () => analyzeWithPlaceId(c.place_id, c.name, c.formatted_address);
    btn.setAttribute("aria-label", `Select ${c.name}`);
    list?.appendChild(btn);
  });

  if (candidates.length === 0) {
    setText("clarHint", "No exact matches. Try adding city/state, shortening the name, pasting the website URL, or trying a broader search (e.g., just the brand + state).");
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

  if (!body.businessName && !lastPlaceId) {
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
    }, 18000);

    const data = await res.json();

    if (!res.ok || !data.success) {
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
    }, 18000);

    const data = await res.json();

    if (!res.ok || !data.success) {
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
  // Prefer detailedScores if provided, otherwise fall back to top-level
  const seo = ds["On-Page SEO"] ?? data.seo ?? 0;
  const cta = ds["Call-to-Action Strength"] ?? data.cta ?? 0;
  const gbp = ds["Overall Rating"] ?? data.gbp ?? 0;
  const reviews = ds["Review Volume"] ?? data?.dials?.reviews ?? 0;
  const pain = ds["Pain Point Resonance"] ?? data?.dials?.pain ?? 0;

  setBar("barSeo", seo); setText("valSeo", seo || "—");
  setBar("barCta", cta); setText("valCta", cta || "—");
  setBar("barGbp", gbp); setText("valGbp", gbp || "—");
  setBar("barReviews", reviews); setText("valReviews", reviews || "—");
  setBar("barPain", pain); setText("valPain", pain || "—");

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

    const data = await res.json();

    if (!res.ok || !data.success) {
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
