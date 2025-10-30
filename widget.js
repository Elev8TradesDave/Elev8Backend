const $ = (id) => document.getElementById(id);
const API = (path) => path; // same origin; adjust if hosting separately

function setBar(id, value) {
  const el = $(id);
  if (!el) return;
  el.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
}

async function analyze() {
  const body = {
    businessName: $("bName").value.trim(),
    websiteUrl: $("webUrl").value.trim(),
    serviceArea: $("area").value.trim(),
    tradeSelect: $("tradeSelect").value,
    fast: $("fast").checked
  };

  setText("details", "Analyzing…");
  try {
    const res = await fetch(API("/api/analyze"), {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!data.success) {
      setText("details", `Error: ${data.error || "Unknown"}`);
      return;
    }

    if (data.clarifications) {
      setText("details", `Clarification needed: ${data.clarifications.message}\n\n` +
        JSON.stringify(data.clarifications.candidates || [], null, 2));
      return;
    }

    // Bars & numbers
    setBar("overallBar", data.finalScore || 0);
    setText("overallPct", `${data.finalScore ?? "—"} / 100`);
    setText("modeBadge", data.mode || "—");

    setBar("barSeo", data.seo || 0); setText("valSeo", `${data.seo ?? "—"}`);
    setBar("barCta", data.cta || 0); setText("valCta", `${data.cta ?? "—"}`);
    setBar("barGbp", data.gbp || 0); setText("valGbp", `${data.gbp ?? "—"}`);

    setBar("barReviews", data.dials?.reviews || 0); setText("valReviews", `${data.dials?.reviews ?? "—"}`);
    setBar("barPain", data.dials?.pain || 0); setText("valPain", `${data.dials?.pain ?? "—"}`);

    // Map
    if (data.mapEmbedUrl) {
      $("mapEmbed").src = data.mapEmbedUrl;
      $("mapEmbedWrap").style.display = "";
    } else {
      $("mapEmbedWrap").style.display = "none";
    }

    // Details
    const { place, weightsUsed, seoBreakdown, ctaBreakdown } = data;
    const det = {
      place,
      mode: data.mode,
      weightsUsed,
      seoBreakdown,
      ctaBreakdown
    };
    setText("details", JSON.stringify(det, null, 2));

    // Auto-fetch competitors
    await competitors(data.placeId, body.tradeSelect, body.serviceArea);

  } catch (e) {
    setText("details", `Request failed: ${e.message}`);
  }
}

async function competitors(placeId, trade, area) {
  setText("competitors", "Fetching competitors…");
  try {
    const res = await fetch(API("/api/competitive-snapshot"), {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ placeId, trade, area })
    });
    const data = await res.json();
    if (!data.success) {
      setText("competitors", `Error: ${data.error || "Unknown"}`);
      return;
    }
    setText("competitors", JSON.stringify({
      query: data.queryUsed,
      biasedBy: data.biasedBy,
      competitors: data.competitors,
      adIntel: data.adIntel
    }, null, 2));
  } catch (e) {
    setText("competitors", `Request failed: ${e.message}`);
  }
}

$("btnAnalyze").addEventListener("click", analyze);
$("btnCompetitors").addEventListener("click", () => {
  const placeId = null; // user can paste one into the form if you add a field
  competitors(placeId, $("tradeSelect").value, $("area").value.trim());
});
$("btnTop").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
