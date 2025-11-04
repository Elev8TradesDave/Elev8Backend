// ---------- Tiny helpers ----------
const $ = (id) => document.getElementById(id);
const setText = (id, txt) => { const el = $(id); if (el) el.textContent = String(txt ?? ""); };
const setWidth = (id, pct) => { const el = $(id); if (el) el.style.width = `${Math.max(0, Math.min(100, pct||0))}%`; };
const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? "" : "none"; };

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
  show("loading", on);
  const a = $("btnAnalyze"), c = $("btnCompetitors");
  if (a) a.disabled = on;
  if (c) c.disabled = on;
}

// ---------- debounce (client-side flood control) ----------
function debounce(fn, wait = 500) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ---------- Candidates UI ----------
function showCandidates(cands) {
  const card = $("candidatesCard");
  const list = $("candidates");
  if (!card || !list) return;
  if (!Array.isArray(cands) || cands.length === 0) {
    card.style.display = "none";
    list.innerHTML = "";
    return;
  }
  card.style.display = "";
  list.innerHTML = "";
  cands.forEach(c => {
    const div = document.createElement("div");
    div.className = "candidate";
    div.innerHTML = `<strong>${c.name || "Candidate"}</strong><div class="small">${c.formatted_address || ""}</div>`;
    // Debounce candidate selection to prevent spam-clicks
    div.onclick = debounce(() => runAnalyze({ placeId: c.placeId }), 500);
    list.appendChild(div);
  });
}

// ---------- Map (with simple localStorage cache of src) ----------
function renderMap(src, hasPlace) {
  const f = $("mapFrame");
  if (!f) return;
  if (hasPlace && src) {
    const key = `map_${src}`;
    const cached = localStorage.getItem(key);
    const finalSrc = cached || src;
    f.src = finalSrc;
    if (!cached) localStorage.setItem(key, src);
    f.style.visibility = "visible";
  } else {
    f.removeAttribute("src");
    f.style.visibility = "hidden";
  }
}

// ---------- Analyze ----------
function runAnalyze(overrides = {}) {
  // reset UI
  showCandidates(null);
  banner("");
  setText("statusPill", "—");
  show("ceilingLine", false);

  const body = {
    businessName: $("bName")?.value,
    serviceArea: $("area")?.value,
    businessType: $("tradeSelect")?.value,
    websiteUrl: $("webUrl")?.value,
    fast: $("fast")?.checked ? 1 : 0,
    siteOnly: $("siteOnly")?.checked ? 1 : 0,
    ...overrides
  };

  const url = "/api/analyze?nocache=" + ($("noCache")?.checked ? "1" : "0");

  setLoading(true);
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(r => r.json())
    .then(data => {
      setLoading(false);

      if (data && data.success === false) {
        if (data.status === "NEEDS_INPUT" && Array.isArray(data.candidates)) {
          banner("Need a service area or pick from candidates to continue.", true);
          showCandidates(data.candidates);
        } else {
          banner(data.message || "Could not analyze this business.", true);
        }
        return;
      }

      setText("finalScore", Math.round(data.finalScore ?? 0));
      setText("rationale", data.rationale || "");
      setText("statusPill", data.status || data.path || "—");
      show("ceilingLine", !!data.ceiling);

      // Bars / Map
      const siteOnlyMode = (data.status === "SITE_ONLY" || data.status === "SITE_ONLY_FORCED");
      const hasPlace = !siteOnlyMode && !!data.placeId && (data.path === "GBP_ONLY" || data.path === "BLENDED_60_40");
      renderMap(data.mapEmbedUrl, hasPlace);
      show("mapHint", !hasPlace);

      if (data.gbp) {
        setWidth("bar-rating",   data.gbp.ratingPct);
        setWidth("bar-volume",   data.gbp.volumePct);
        setWidth("bar-category", data.gbp.categoryPct);
        setWidth("bar-photos",   data.gbp.photosPct);
        setWidth("bar-hours",    data.gbp.hoursPct);
      }
      if (siteOnlyMode) {
        ["bar-rating","bar-volume","bar-category","bar-photos","bar-hours"].forEach(id => setWidth(id, 0));
      }

      // Banners
      if (data.status === "SITE_ONLY") {
        banner("Provisional website-only score (no GBP found). Add/claim your GBP to raise the ceiling.");
      } else if (data.status === "SITE_ONLY_FORCED") {
        banner("Website-only mode enabled. Create/optimize GBP to raise the ceiling.");
      } else if (data.status === "GBP_ONLY") {
        banner("GBP-only score (website missing or unreachable). Adding a website can raise your ceiling.");
      } else if (data.status === "NEEDS_INPUT") {
        banner("Need a service area or pick from candidates to continue.", true);
      } else {
        banner("");
      }

      if (Array.isArray(data.candidates) && data.candidates.length) {
        showCandidates(data.candidates);
      }
    })
    .catch(err => {
      setLoading(false);
      banner("Unexpected error. Check console.", true);
      console.error(err);
    });
}

// ---------- Competitors ----------
let compSortKey = "rating";
let compSortDir = "desc";

function renderCompetitors(payload) {
  const card = $("competitorsCard");
  const tbody = $("compTbody");
  const meta  = $("compMeta");
  if (!card || !tbody || !meta) return;

  if (!payload || !payload.ok || !Array.isArray(payload.items)) {
    card.style.display = "none";
    return;
  }

  // Sort
  const items = [...payload.items];
  items.sort((a,b) => {
    const k = compSortKey;
    const dir = compSortDir === "desc" ? -1 : 1;

    if (k === "openNow") {
      const mapVal = v => (v === true ? 2 : v === false ? 1 : 0);
      return (mapVal(a.openNow) - mapVal(b.openNow)) * dir;
    }

    let va = a[k], vb = b[k];
    if (k === "name" || k === "address") {
      va = String(va || "").toLowerCase(); vb = String(vb || "").toLowerCase();
      return va.localeCompare(vb) * dir;
    }
    if (k === "types") {
      va = (a.types && a.types[0]) ? a.types[0] : "";
      vb = (b.types && b.types[0]) ? b.types[0] : "";
      return String(va).localeCompare(String(vb)) * dir;
    }
    va = Number(va || 0); vb = Number(vb || 0);
    return (va - vb) * dir;
  });

  // Render
  tbody.innerHTML = "";
  for (const it of items) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${it.rank ? `#${it.rank} ` : ""}${it.name || ""}</strong></td>
      <td class="nowrap">${(it.rating ?? 0).toFixed(1)}</td>
      <td class="nowrap">${it.reviews ?? 0}</td>
      <td>${(it.types && it.types[0]) ? it.types[0].replace(/_/g," ") : ""}</td>
      <td>${it.address || ""}</td>
      <td class="nowrap">${it.openNow === null ? "—" : (it.openNow ? "Open" : "Closed")}</td>
      <td class="nowrap">${it.photosCount || 0}</td>
      <td class="nowrap">
        ${it.website ? `<a href="${it.website}" target="_blank" rel="noopener">Site</a> · ` : ""}
        <a href="${it.mapsLink}" target="_blank" rel="noopener">Maps</a>
      </td>
    `;
    tbody.appendChild(tr);
  }

  meta.textContent = `${payload.total} competitors for “${payload.trade}” in “${payload.area}”. Click headers to sort.`;
  card.style.display = "";
}

function runCompetitors() {
  const name  = $("bName")?.value?.trim();
  const area  = $("area")?.value?.trim();
  const trade = $("tradeSelect")?.value?.trim();
  const noc   = $("noCache")?.checked ? "1" : "0";

  let url;
  if (name && area && trade) {
    url = `/api/competitive-snapshot?nocache=${noc}&businessName=${encodeURIComponent(name)}&serviceArea=${encodeURIComponent(area)}&businessType=${encodeURIComponent(trade)}`;
  } else if (trade && area) {
    url = `/api/competitive-snapshot?nocache=${noc}&businessType=${encodeURIComponent(trade)}&serviceArea=${encodeURIComponent(area)}`;
  } else {
    banner("Enter a trade and service area (and optionally the business name) to load competitors.", true);
    return;
  }

  setLoading(true);
  fetch(url)
    .then(r => r.json())
    .then(data => {
      setLoading(false);
      if (!data.ok || !Array.isArray(data.items)) {
        banner(data.error || "No competitors found.", true);
        return;
      }
      window._lastCompPayload = data;
      renderCompetitors(data);
      banner(`Competitors loaded (${data.total}).`);
    })
    .catch(err => {
      setLoading(false);
      banner("Competitive snapshot error.", true);
      console.error(err);
    });
}

// Simple sortable headers (+keyboard)
["name","rating","reviews","types","address","openNow","photosCount"].forEach(k => {
  const ths = document.querySelectorAll(`th[data-k="${k}"]`);
  ths.forEach(th => {
    const handler = () => {
      if (compSortKey === k) compSortDir = (compSortDir === "desc" ? "asc" : "desc");
      else { compSortKey = k; compSortDir = "desc"; }
      const raw = window._lastCompPayload;
      if (raw) renderCompetitors(raw);
    };
    th.addEventListener("click", handler);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") handler(); });
  });
});

// ---------- Playbook Modal ----------
function updatePlaybookTitle() {
  const sel = $("tradeSelect");
  const text = sel?.options?.[sel.selectedIndex]?.text;
  setText("pb-title", (text && text !== "— Select —") ? `${text} Local Visibility Playbook` : "Local Services Playbook");
}
function openPlaybook() { updatePlaybookTitle(); $("playbookBackdrop").style.display = "flex"; }
function closePlaybook() { $("playbookBackdrop").style.display = "none"; }

// ---------- Wire up (debounced buttons) ----------
$("btnAnalyze").addEventListener("click", debounce(() => runAnalyze(), 500));
$("btnCompetitors").addEventListener("click", debounce(runCompetitors, 500));
$("btnPlaybook").addEventListener("click", openPlaybook);
$("pb-close-1").addEventListener("click", closePlaybook);
$("pb-close-2").addEventListener("click", closePlaybook);
$("playbookBackdrop").addEventListener("click", (e) => { if (e.target.id === "playbookBackdrop") closePlaybook(); });
$("tradeSelect").addEventListener("change", updatePlaybookTitle);
