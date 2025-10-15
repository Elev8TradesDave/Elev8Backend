// Use a relative API so this works on Render and localhost.
// Keep ?quick=1 for fast smoke tests. Remove it later for full analysis.
const API = "/api/analyze?quick=1";

function esc(s) { return s.toString().replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const form = document.getElementById('analysisForm');
const analyzeButton = document.getElementById('analyzeButton');
const resultsContainer = document.getElementById('results');

async function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), ms));
  return Promise.race([promise, timeout]);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const businessName = document.getElementById('businessName').value.trim();
  const websiteUrl = document.getElementById('websiteUrl').value.trim();
  const businessType = document.querySelector('input[name="businessType"]:checked')?.value;
  const serviceArea = document.getElementById('serviceArea').value.trim();

  if (!businessName || !websiteUrl || !businessType) {
    alert('Please fill out all required fields.');
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.textContent = "Analyzing...";

  try {
    const fetchPromise = fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, websiteUrl, businessType, serviceArea })
    });

    const response = await withTimeout(fetchPromise, 30000); // 30s timeout
    if (!response.ok) throw new Error("Server returned an error");
    const data = await response.json();
    displayResults(data);
  } catch (error) {
    resultsContainer.style.display = "block";
    resultsContainer.innerHTML = `<p style="color: red;"><strong>Error:</strong> ${esc(error.message)}</p>`;
    console.error("Fetch error:", error);
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = "Analyze My Business";
  }
});

function displayResults(data) {
  const detailedBarsHTML = Object.entries(data.detailedScores || {}).map(([key, value]) => `
    <div class="bar-row">
      <span class="bar-label">${esc(key)}</span>
      <div class="bar-container">
        <div class="bar" style="width: ${Number(value) || 0}%;"></div>
      </div>
      <span class="bar-value">${Number(value) || 0}</span>
    </div>
  `).join('');

  const logicExplainer = `
Your score reflects Google search visibility, based on:
- Overall Rating: Your average star rating from Google reviews.
- Review Volume: Number of reviews influencing trust.
- Pain Point Resonance: How well your website addresses customer pain points (AI-estimated).
- Call-to-Action Strength: Clarity of your website’s calls to action (AI-estimated).
- Website Health: Technical health of your site (AI-estimated).
- On-Page SEO: Keyword optimization (AI-estimated).
`.trim();

  let safeMapUrl = '';
  if (data.mapEmbedUrl && data.mapEmbedUrl.startsWith("https://www.google.com/maps")) {
    safeMapUrl = data.mapEmbedUrl.includes("output=embed")
      ? data.mapEmbedUrl
      : (data.mapEmbedUrl.includes("?")
          ? data.mapEmbedUrl + "&output=embed"
          : data.mapEmbedUrl + "?output=embed");
  }

  const safeFinalScore = Number(data.finalScore) || 70;
  const safeTopPriority = esc((data.geminiAnalysis && data.geminiAnalysis.topPriority) || '—');
  const safeReviewSentiment = esc((data.geminiAnalysis && data.geminiAnalysis.reviewSentiment) || '—');
  const safeCompetitorName = esc((data.topCompetitor && data.topCompetitor.name) || "Top Competitor");
  const safeCompetitorAnalysis = esc((data.geminiAnalysis && data.geminiAnalysis.competitorAdAnalysis) || '—');

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
}
