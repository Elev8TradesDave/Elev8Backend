// Works on Render and localhost
const API_PATH = "/api/analyze";

function esc(s) { return String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function normalizeWebsite(raw) {
  let v = (raw || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    u.protocol = "https:";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return ("https://" + v.replace(/^\/*/, "")).replace(/\/+$/, "");
  }
}

const form = document.getElementById("analysisForm");
const analyzeButton = document.getElementById("analyzeButton");
const results = document.getElementById("results");
const formError = document.getElementById("formError");
const fastMode = document.getElementById("fastMode");

function bar(label, value) {
  const v = Math.max(0, Math.min(100, Math.round(value || 0)));
  return `
    <div class="row">
      <div class="bar-value"><strong>${esc(label)}:</strong> ${v}%</div>
      <div class="bar-container"><div class="bar" style="width:${v}%"></div></div>
    </div>`;
}

// --- Clarifications UI ---
function renderClarifications(list = []) {
  if (!Array.isArray(list) || !list.length) return "";
  const items = list.map((c, idx) => {
    const msg = c.message || "Want me to try a fix?";
    const btn = c.suggestion
      ? `<button type="button" class="clar-btn" data-i="${idx}">${esc(c.suggestion.label || "Apply suggestion")}</button>`
      : "";
    return `
      <div class="row" style="border:1px solid #e5e7eb;border-radius:12px;padding:12px">
        <div class="logic-explainer" style="margin-bottom:8px">${esc(msg)}</div>
        ${btn}
      </div>`;
  }).join("");

  return `
    <div class="row" style="margin-top:16px">
      <strong>Suggestions to refine your search</strong>
    </div>
    ${items}
  `;
}

function wireClarificationButtons(clarifications) {
  const buttons = results.querySelectorAll(".clar-btn");
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      const i = Number(btn.getAttribute("data-i"));
      const s = clarifications?.[i]?.suggestion;
      if (!s) return;

      if (s.field === "serviceArea") {
        document.getElementById("serviceArea").value = s.value || "";
      } else if (s.field === "websiteUrl") {
        document.getElementById("websiteUrl").value = s.value || "";
      } else if (s.field === "businessName") {
        document.getElementById("businessName").value = s.value || "";
      }
      form.requestSubmit();
    });
  });
}

// --- Main result UI ---
function renderResult(payload) {
  const { finalScore, detailedScores, geminiAnalysis, topCompetitor, mapEmbedUrl, clarifications } = payload;

  let html = `
    <div class="score">Overall Score: ${finalScore}%</div>
    ${bar("Overall Rating", detailedScores["Overall Rating"])}
    ${bar("Review Volume", detailedScores["Review Volume"])}
    ${bar("Pain Point Resonance", detailedScores["Pain Point Resonance"])}
    ${bar("Call-to-Action Strength", detailedScores["Call-to-Action Strength"])}
    ${bar("Website Health", detailedScores["Website Health"])}
    ${bar("On-Page SEO", detailedScores["On-Page SEO"])}
  `;

  html += `
    <details open>
      <summary><strong>Recommended Next Step</strong></summary>
      <div class="logic-explainer">${esc(geminiAnalysis?.topPriority || "No suggestion")}</div>
    </details>
    <details>
      <summary><strong>Competitor Ad Themes</strong></summary>
      <div class="logic-explainer">${esc(geminiAnalysis?.competitorAdAnalysis || "—")}</div>
    </details>
    <details>
      <summary><strong>Review Sentiment</strong></summary>
      <div class="logic-explainer">${esc(geminiAnalysis?.reviewSentiment || "—")}</div>
    </details>
  `;

  if (topCompetitor?.name) {
    html += `
      <div class="row">
        <strong>Top Competitor:</strong> ${esc(topCompetitor.name)}
        ${topCompetitor.website ? `&nbsp;— <a href="${esc(topCompetitor.website)}" target="_blank" rel="noopener">website</a>` : ""}
      </div>`;
  }

  if (mapEmbedUrl) {
    html += `
      <div class="map-container">
        <iframe src="${esc(mapEmbedUrl)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
      </div>`;
  }

  html += renderClarifications(clarifications);
  results.innerHTML = html;
  wireClarificationButtons(clarifications);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.style.display = "none";
  results.innerHTML = "";

  const businessName = document.getElementById("businessName").value.trim();
  const websiteUrl = normalizeWebsite(document.getElementById("websiteUrl").value);
  const serviceArea = document.getElementById("serviceArea").value.trim();
  const businessType = [...document.querySelectorAll('input[name="businessType"]')].find(i => i.checked)?.value;

  if (!businessName || !websiteUrl || !businessType) {
    formError.textContent = "Please complete all required fields.";
    formError.style.display = "block";
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.textContent = "Analyzing…";

  try {
    const qs = fastMode.checked ? "?quick=1" : "";
    const res = await fetch(`${API_PATH}${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, websiteUrl, businessType, serviceArea })
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data?.success) {
      const clar = Array.isArray(data?.clarifications) ? data.clarifications : [];
      if (clar.length) {
        results.innerHTML = renderClarifications(clar);
        wireClarificationButtons(clar);
        throw new Error(data?.message || data?.error || "Try one of the suggestions above.");
      }
      throw new Error(data?.message || data?.error || "Analysis failed.");
    }

    renderResult(data);
  } catch (err) {
    console.error(err);
    formError.textContent = err.message || "Something went wrong.";
    formError.style.display = "block";
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "Analyze My Business";
  }
});
