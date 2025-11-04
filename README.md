Elev8Trades Competitive Analysis – Backend \& Widget



A small Node/Express service (Render/Vercel-friendly) that analyzes a local contractor’s web presence using Google Places, Geocoding, and PageSpeed Insights (PSI), optionally enriched by Gemini. It also serves a minimal widget UI at /.



Overview



Endpoints



GET / – simple HTML form + results UI (widget.html + widget.js)



GET /api/health – health \& env visibility



POST /api/analyze – full analysis (uses Google + optional Gemini)



POST /api/analyze?quick=1 – quick mode (no external API calls)



GET /api/reverse?lat=..\&lon=.. – reverse geocode to City, ST



Keys



GOOGLE\_MAPS\_API\_KEY → server key (enables Places, Geocoding, PSI)



GOOGLE\_MAPS\_EMBED\_KEY → browser/embed key (locked by referrers)



GEMINI\_API\_KEY → optional; only needed for full analysis



Security



Server key is never leaked to the browser.



Embed key is used only in iframe URLs and should be locked to your site’s referrers.



CSP is configured to allow Google Maps embeds and common Google image hosts.





\# Local Visibility Analysis Engine — Scoring Spec (v1)

\_Last updated: October 31, 2025\_



This document defines how the \*\*v1 scoring\*\* works for the Local Visibility Analysis Engine. It describes the inputs, signal normalizations, weights, blending logic, edge cases, and examples. Paste this section in your project `README.md` under “How Scoring Works.”



---



\## Overview

We compute a \*\*0–100 score\*\* from two buckets of public signals:



1\. \*\*Google Business Profile (GBP) signals\*\* — always attempted

2\. \*\*Website signals\*\* — only used if a website is present \*\*and\*\* reachable within 4s



We use an \*\*adaptive blend\*\*:

\- If the website is \*\*reachable\*\* → \*\*BLENDED\_60\_40\*\* (60% GBP, 40% Website)

\- If the website is \*\*missing or unreachable\*\* → \*\*GBP\_ONLY\*\* (no penalty for missing site)



We \*\*never\*\* return a hardcoded fallback (e.g. “70”). If there isn’t enough public data, we return an error (`insufficient\_data`).



---



\## Terms \& Normalization

\- All component subscores are normalized to \*\*0–100\*\* (internally 0–1 before weighting).

\- Final scores are \*\*rounded to nearest integer\*\* in 0–100 and \*\*clamped\*\* to that range.

\- Notation: `normX` ∈ \[0,1], `ScoreX` ∈ \[0,100].



---



\## GBP Signals (weights sum to 100)

Data source: \*\*Place Details\*\* for the selected `place\_id`.



| Component        | Normalization (0–1)                                                                                                   | Weight |

|------------------|------------------------------------------------------------------------------------------------------------------------|:------:|

| Rating Quality   | `ratingNorm = clamp(rating / 5, 0, 1)`                                                                                |  40%   |

| Review Volume    | `volNorm = f(reviews)` where: 0→0; 1–4→0.25; 5–19→0.40; 20–49→0.60; 50–99→0.80; 100–249→0.90; ≥250→1.00               |  25%   |

| Category Match   | If `expectedTradeLabel` found in GBP types or editorial summary → \*\*1.00\*\*; else \*\*0.60\*\*; if no trade given → \*\*0.80\*\* |  15%   |

| Photos Present   | Has at least 1 photo → \*\*1.00\*\* else \*\*0.00\*\*                                                                          |  10%   |

| Hours Present    | Has opening hours info → \*\*1.00\*\* else \*\*0.00\*\*                                                                        |  10%   |



\*\*GBP Score formula\*\*

```

GBP = 100 \* ( 0.40\*ratingNorm

&nbsp;           + 0.25\*volNorm

&nbsp;           + 0.15\*categoryNorm

&nbsp;           + 0.10\*photosNorm

&nbsp;           + 0.10\*hoursNorm )

```



> \_Note:\_ In v1, rating quality and volume are \*\*independent\*\* components. A “credibility dampener” (reducing rating weight when reviews are very low) is reserved for v1.1 tuning.



---



\## Website Signals (weights sum to 100)

We first \*\*probe\*\* the site with a `HEAD` request (timeout: \*\*4s\*\*). If the website is not reachable in time, the site score is \*\*0\*\* and we take the \*\*GBP\_ONLY\*\* path (no penalty).



| Component           | Normalization (0–1)                                                                          | Weight |

|---------------------|-----------------------------------------------------------------------------------------------|:------:|

| Reachable           | If `HEAD` responds OK within 4s → \*\*1.00\*\*; else \*\*0.00\*\*                                     |  40%   |

| HTTPS               | URL starts with `https://` → \*\*1.00\*\*; else \*\*0.00\*\*                                          |  25%   |

| Contact Presence    | Best-effort `HEAD` on `/contact` responds OK → \*\*1.00\*\*; else \*\*0.00\*\*                        |  20%   |

| Content Proxy       | From `content-length` header: ≥20000 → \*\*1.00\*\*; 5000–19999 → \*\*0.60\*\*; 1–4999 → \*\*0.30\*\*; 0 → \*\*0.00\*\* |  15%   |



\*\*Website Score formula\*\*

```

SITE = 100 \* ( 0.40\*reachableNorm

&nbsp;            + 0.25\*httpsNorm

&nbsp;            + 0.20\*contactNorm

&nbsp;            + 0.15\*contentNorm )

```



---



\## Adaptive Blend \& Final Score

\- \*\*Path selection\*\*

&nbsp; - `BLENDED\_60\_40` if website exists \*\*and\*\* is reachable (within 4s)

&nbsp; - `GBP\_ONLY` if website is missing or not reachable (within 4s)



\- \*\*Final Score\*\*

```

FINAL = round( 0.60\*GBP + 0.40\*SITE )    if path = BLENDED\_60\_40

FINAL = round( GBP )                     if path = GBP\_ONLY

```



\- \*\*No Fallbacks\*\*: If \*\*all\*\* GBP signals are absent (no rating, no reviews, no photos, no hours) \*\*and\*\* there is no website provided, return `422 insufficient\_data` instead of a number.



---



\## Edge-Case Policy

\- \*\*Ambiguous matches\*\*: If Text Search yields multiple strong candidates, return `ambiguous=true` with top 3 options (name + vicinity + place\_id). Don’t guess silently.

\- \*\*Slow or flaky websites\*\*: Time-box site probe to 4s. If it times out or fails, we use `GBP\_ONLY` and explain why in the response `rationale`.

\- \*\*Partial GBP data\*\*: Compute GBP with whatever exists; missing components simply contribute 0 to that component.

\- \*\*Clamping/Rounding\*\*: Subscores are expressed as integers 0–100 for the UI. Internal math uses floats; final score is rounded and clamped to \[0,100].



---



\## Response Shape (reference)

```json

{{

&nbsp; "success": true,

&nbsp; "placeId": "ChIJ...",

&nbsp; "path": "GBP\_ONLY | BLENDED\_60\_40",

&nbsp; "finalScore": 0,

&nbsp; "signals": {{

&nbsp;   "gbp": {{

&nbsp;     "ratingQuality": 0,

&nbsp;     "reviewVolume": 0,

&nbsp;     "categoryMatch": 0,

&nbsp;     "photos": 0,

&nbsp;     "hours": 0,

&nbsp;     "raw": {{ "rating": 0, "reviews": 0, "primaryType": "" }}

&nbsp;   }},

&nbsp;   "site": {{

&nbsp;     "reachable": 0,

&nbsp;     "https": 0,

&nbsp;     "contact": 0,

&nbsp;     "content": 0,

&nbsp;     "checked": true,

&nbsp;     "reachable": false

&nbsp;   }}

&nbsp; }},

&nbsp; "rationale": "Plain-English one-liner about which path and why.",

&nbsp; "debug": {{

&nbsp;   "candidateCount": 1,

&nbsp;   "ambiguous": null,

&nbsp;   "name": "Acme Co",

&nbsp;   "address": "123 Main...",

&nbsp;   "rating": 4.6,

&nbsp;   "reviews": 120,

&nbsp;   "website": "https://..."

&nbsp; }}

}}

```



---



\## UI Mapping

\- \*\*Recommended bars (compact 6):\*\* Rating Quality, Review Volume, Category Match, Photos, Hours, \*\*Website Health\*\* (aggregate of site subscores).

\- \*\*Alternate bars (detailed 9):\*\* Show all 5 GBP subscores \*\*plus\*\* the 4 Website subscores.



---



\## Worked Examples



\### Example 1 — Strong GBP + Strong Site (Blended)

\- GBP: rating 4.6 → 0.92; reviews 120 → 0.80; category match → 1.00; photos → 1.00; hours → 1.00  

&nbsp; `GBP = 100 \* (0.40\*0.92 + 0.25\*0.80 + 0.15\*1 + 0.10\*1 + 0.10\*1)` = \*\*92\*\*

\- Site: reachable (1), https (1), contact (1), content ≥ 20000 (1)  

&nbsp; `SITE = 100 \* (0.40\*1 + 0.25\*1 + 0.20\*1 + 0.15\*1)` = \*\*100\*\*

\- Path = BLENDED\_60\_40 ⇒ `FINAL = round(0.60\*92 + 0.40\*100)` = \*\*95\*\*



\### Example 2 — High Rating, Very Low Reviews, No Site (GBP Only)

\- GBP: rating 4.9 → 0.98; reviews 8 → 0.40; category match → 1.00; photos → 1.00; hours → 0.00  

&nbsp; `GBP = 100 \* (0.40\*0.98 + 0.25\*0.40 + 0.15\*1 + 0.10\*1 + 0.10\*0)` = \*\*74\*\*

\- No site ⇒ Path = GBP\_ONLY ⇒ `FINAL = 74`



\### Example 3 — Moderate GBP + Partial Site (Blended)

\- GBP (illustrative): rating 4.2 → 0.84; reviews 45 → 0.60; category → 1.00; photos → 1.00; hours → 1.00  

&nbsp; `GBP ≈ 86`

\- Site: reachable (1), https (1), contact (0), content 8000 → 0.60  

&nbsp; `SITE = 100 \* (0.40\*1 + 0.25\*1 + 0.20\*0 + 0.15\*0.60)` = \*\*74\*\*

\- Path = BLENDED\_60\_40 ⇒ `FINAL = round(0.60\*86 + 0.40\*74)` = \*\*82\*\*



---



\## Tuning \& Versioning

The following are \*\*fixed for v1\*\*:

\- GBP weights: 40/25/15/10/10

\- Site weights: 40/25/20/15

\- Blend ratio: 60/40 (GBP/Site)

\- Timeouts: 8s (Google), 4s (website probe)



Reserved for \*\*v1.1\*\* experiments:

\- Rating credibility dampener at very low review counts

\- Finer category matching (synonyms per trade)

\- Richer site checks (title/meta parsing, NAP/Schema detection)



---



\## Acceptance Criteria (Scoring)

\- No hardcoded defaults; \*\*every score is computed from signals\*\*.

\- Paths are explicit (`GBP\_ONLY` or `BLENDED\_60\_40`) and logged.

\- Subscores and `finalScore` are present and sum consistently with weights.

\- Insufficient public data returns `422 insufficient\_data`.



