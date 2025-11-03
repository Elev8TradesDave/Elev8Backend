// ---------- Helpers ----------
function $(id) { return document.getElementById(id); }

function banner(text, isError=false) {
  const host = $("bannerHost");
  if (!host) return;
  host.innerHTML = "";
  if (!text) return;
  const el = document.createElement("div");
  el.className = "banner" + (isError ? " error" : "");
  el.textContent = text;
  host.appendChild(el);
}

function setLoading(on) {
  $("loading").style.display = on ? "block" : "none";
  $("btnAnalyze").disabled = on;
}

// ---------- Playbook Modal ----------
function openPlaybook() { $("playbookBackdrop").style.display = "flex"; }
function closePlaybook() { $("playbookBackdrop").style.display = "none"; }

$("btnPlaybook").addEventListener("click", openPlaybook);
$("pb-close-1").addEventListener("click", closePlaybook);
$("pb-close-2").addEventListener("click", closePlaybook);
$("playbookBackdrop").addEventListener("click", (e) => {
  if (e.target.id === "playbookBackdrop") closePlaybook();
});

// ---------- Name variants (SAB) ----------
function generateNameVariants(name) {
  const n = (name || "").trim();
  const set = new Set();
  if (!n) return [];
  const base = n
    .replace(/\binc\.?\b/gi, "")
    .replace(/\bllc\b/gi, "")
    .replace(/\bco\.?\b/gi, "")
    .replace(/\bcorp\.?\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  set.add(n);
  set.add(base);
  set.add(base.replace(/\ball\s*state\b/gi, "Allstate"));
  set.add(base.replace(/\ballstate\b/gi, "All State"));
  return Array.from(set).filter(Boolean);
}
function populateAltNames() {
  const sel = $("altNames");
  sel.innerHTML = "";
  const options = generateNameVariants($("bName").value);
  if (options.length === 0) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "—"; sel.appendChild(o);
  } else {
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt; sel.appendChild(o);
    }
  }
}
$("bName").addEventListener("input", populateAltNames);
$("btnUseAlt").addEventListener("click", () => {
  const v = $("altNames").value;
  if (v) $("bName").value = v;
});
populateAltNames();

// ---------- Candidate picker ----------
function showCandidates(list) {
  const box = $("candidateBox");
  const sel = $("candidateSelect");
  sel.innerHTML = "";
  if (!list || !list.length) { box.style.display = "none"; return; }
  for (const c of list) {
    const o = document.createElement("option");
    o.value = c.place_id;
    o.textContent = `${c.name} — ${c.vicinity || c.formatted_address || ""}`.trim();
    sel.appendChild(o);
  }
  box.style.display = "block";
}
$("btnUseCandidate").addEventListener("click", async () => {
  const pid = $("candidateSelect").value;
  if (!pid) return;
  await runAnalyze({ placeId: pid });
});

// ---------- UI Mapping ----------
function setWidth(id, v) { $(id).style.width = `${Math.max(0, Math.min(100, v||0))}%`; }

function renderPlace(place) {
  if (!place) { $("placeBlock").textContent = "—"; return; }
  const lines = [];
  if (place.name) lines.push(place.name);
  if (place.address) lines.push(place.address);
  if (place.rating != null) lines.push(`Rating: ${place.rating} (${place.user_ratings_total ?? 0})`);
  if (place.website) lines.push(place.website);
  $("placeBlock").textContent = lines.join(" • ");
}

function renderBars(data) {
  const gbp = data?.signals?.gbp || {};
  const site = data?.signals?.site || {};

  setWidth("bar-rating", gbp.ratingQuality);
  setWidth("bar-volume", gbp.reviewVolume);
  setWidth("bar-category", gbp.categoryMatch);
  setWidth("bar-photos", gbp.photos);
  setWidth("bar-hours", gbp.hours);

  setWidth("bar-seo", site.seo);
  setWidth("bar-cta", site.cta);

  $("siteNote").textContent =
    site?.reachable === false && data?.place?.website
      ? "Website not reachable within time; blended path disabled."
      : site?.checked ? "" : "No website checks were run.";
}

function renderMap(url) {
  $("mapFrame").src = url || "";
}

function renderPathPill(pathOrStatus) {
  const pill = $("pathPill");
  pill.textContent = pathOrStatus || "—";
}

// ---------- Analyze ----------
async function runAnalyze(overrides = {}) {
  try {
    banner("");
    setLoading(true);
    showCandidates(null);

    const body = {
      businessName: $("bName").value,
      serviceArea: $("area").value,
      businessType: $("tradeSelect").value,
      websiteUrl: $("webUrl").value,
      fast: $("fast").checked ? 1 : 0,
      ...overrides,
    };

    const q = $("nocache").checked ? "?nocache=1" : "";
    const res = await fetch("/api/analyze" + q, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok || data.success === false) {
      banner(data?.message || "Request failed.", true);
      setLoading(false);
      return;
    }

    // Candidate suggestions (from debug.ambiguous for now)
    showCandidates(data?.debug?.ambiguous);

    // Banners by status
    if (data.status === "SITE_ONLY") {
      banner("Provisional website-only score (no GBP found). Add/claim your GBP for a fuller score.");
    } else if (data.status === "NEEDS_INPUT") {
      banner("We couldn’t find a GBP and no website was provided. Add a website URL or create/claim your GBP, then re-run.");
    } else {
      banner("");
    }

    // Headline
    $("finalScore").textContent = (data.finalScore ?? "—");
    $("rationale").textContent = data.rationale || "—";
    renderPathPill(data.path || data.status);

    // Place, bars, map
    renderPlace(data.place);
    renderBars(data);
    renderMap(data.mapEmbedUrl);

  } catch (e) {
    banner(String(e), true);
  } finally {
    setLoading(false);
  }
}

$("btnAnalyze").addEventListener("click", () => runAnalyze());
