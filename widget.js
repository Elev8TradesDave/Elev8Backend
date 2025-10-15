// Works on Render and localhost
const API_PATH = "/api/analyze";

function esc(s) { return String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function isHttpUrl(u) { try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; } catch { return false; } }

const form = document.getElementById("analysisForm");
const analyzeButton = document.getElementById("analyzeButton");
const resultsContainer = document.getElementById("results");
const fastMode = document.getElementById("fastMode");
const formError = document.getElementById("formError");

async function withTimeout(promise, ms) {
  const t = new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms));
  return Promise.race([promise, t]);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.style.display = "none";
  formError.textContent = "";

  const businessName = document.getElementById("businessName").value.trim();
  const websiteUrl = document.getElementById("websiteUrl").value.trim();
  const businessType = document.querySelector('input[name="businessType"]:checked')?.value;
  const serviceArea = document.getElementById("serviceArea").value.trim();

  // Minimal validation
  if (!businessName || !websiteUrl || !businessType) {
    formError.textContent = "Please fill out all required fields.";
    formError.style.display = "block";
    return;
  }
  if (!isHttpUrl(websiteUrl)) {
    formError.textContent = "Website URL must start with http:// or https://";
    formError.style.display = "block";
    return;
  }

  analyzeButton.disabled = true;
  const oldLabel = analyzeButton.textContent;
  analyzeButton.textContent = "Analyzing…";

  try {
    const endpoint = fastMode?.checked ? `${API_PATH}?quick=1` : API_PATH;

    const fetchPromise = fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, websiteUrl, businessType, serviceArea })
    });

    // Give full analysis a little more time; quick mode returns fast anyway.
    const response = await withTimeout(fetchPromise, fastMode?.checked ? 30000 : 45000);
    if (!response.ok) throw new Error(`Server error (${response.status})`);

    const data = await response.json();
    displayResults(data);
  } catch (error) {
    resultsContainer.style.display = "block";
    resultsContainer.innerHTML = `<p style="color:#b91c1c"><strong>Error:</strong> ${esc(error.message || error)}</p>`;
    console.error("Fetch error:", error);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = oldLabel;
  }
});

function displayResults(data) {
  const detailedBarsHTML = Object.entries(data?.detailedScores || {}).map(([key, value]) => `
    <div class="bar-row">
      <span class="bar-label">${esc(key)}</span>
      <div class="bar-container">
        <div class="bar" style="width: ${Number(value) || 0}%;"></div>
      </div>
      <span class="bar-value">${Number(value) || 0}</span>
    </div>
  `).join("");

  const logicExplainer = `
Your score reflects Google search visibility, based on:
- Overall Rating: Your average star rating from Google reviews.
- Review Volume: Number of reviews influencing trust.
- Pain Point Resonance: How well your website addresses customer pain points (AI-estimated).
- Call-to-Action Strength: Clarity of your website’s calls to action (AI-estimated).
- Website Health: Technical health of your site (AI-estimated).
- On-Page SEO: Keyword optimization (AI-estimated).
`.trim();

  // IMPORTANT: Do NOT append output=embed. The /maps/embed/v1/... URL is already embeddable.
  let safeMapUrl = "";
  if (typeof data?.mapEmbedUrl === "string" &&
      data.mapEmbedUrl.startsWith("https://www.google.com/maps/embed/")) {
    safeMapUrl = data.mapEmbedUrl;
  }

  const safeFinalScore = Number(data?.finalScore) || 70;
  const ga = data?.geminiAnalysis || {};
  const safeTopPriority = esc(ga.topPriority || "—");
  const safeReviewSentiment = esc(ga.reviewSentiment || "—");
  const safeCompetitorName = esc(data?.topCompetitor?.name || "Top Competitor");
  const safeCompetitorAnalysis = esc(ga.competitorAdAnalysis || "—");

  const resultsHTML = `
    <div class="score-display">
      <div class="label">Your Local Visibility Score</div>
      <div class="score">${safeFinalScore}</div>
    </div>

    <div class="info-box">
      <div class="info-title">Your Top Priority:</div>
      <p>${safeTopPriority}</p>
    </div>

    <div class="info-box">
      <div class="info-title">Key Customer Insight (from Reviews):</div>
      <p>${safeReviewSentiment}</p>
    </div>

    <h2>Score Breakdown</h2>
    <div class="bar-chart">
      ${detailedBarsHTML}
    </div>

    <h3>Your #1 Digital Competitor</h3>
    <div class="info-box">
      <div class="info-title">${safeCompetitorName}</div>
      <p>When customers search for your trade in this area, Google often shows this business first. This makes them your primary rival for organic leads.</p>
      <p><strong>Their Ad Strategy:</strong> ${safeCompetitorAnalysis}</p>
    </div>

    ${safeMapUrl ? `
      <div class="map-container">
        <iframe loading="lazy" allowfullscreen src="${safeMapUrl}"></iframe>
      </div>` : ``}

    <details>
      <summary>How We Calculated Your Score</summary>
      <div class="logic-explainer">
        ${esc(logicExplainer)}
      </div>
    </details>
  `;

  resultsContainer.innerHTML = resultsHTML;
  resultsContainer.style.display = "block";
  resultsContainer.scrollIntoView({ behavior: "smooth", block: "start" });
}
