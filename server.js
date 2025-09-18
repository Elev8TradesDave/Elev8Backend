require('dotenv').config();

// --- IMPORTS ---
const express = require('express');
const cors = require('cors');
const { Client } = require("@googlemaps/google-maps-services-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const puppeteer = require('puppeteer');

// --- INITIALIZATION ---
const app = express();
app.use(cors());
app.use(express.json());

// Initialize API clients
const mapsClient = new Client({});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });


// --- AD SCRAPING FUNCTION ---
async function scrapeGoogleAds(domain) {
    let browser;
    try {
        console.log(`Starting ad scrape for ${domain}...`);
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto('https://adstransparency.google.com/', { waitUntil: 'networkidle2' });

        await page.waitForSelector('input[placeholder="Advertiser name, topic or website"]');
        await page.type('input[placeholder="Advertiser name, topic or website"]', domain);
        await page.keyboard.press('Enter');

        console.log('Searching for ads...');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await page.waitForSelector('[data-test-id="ad-creative-card"]', { timeout: 10000 });
        
        console.log('Ads found! Extracting text...');
        const ads = await page.evaluate(() => {
            const adCards = Array.from(document.querySelectorAll('[data-test-id="ad-creative-card"]')).slice(0, 3);
            return adCards.map(card => card.innerText || '');
        });

        console.log(`Scraping finished. Found ${ads.length} ads.`);
        return ads;
    } catch (error) {
        console.log(`Could not find ads for ${domain}. It's okay, continuing analysis.`);
        return [];
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}


// --- THE MAIN ANALYSIS ENDPOINT ---
app.post('/analyze', async (req, res) => {
    const { businessName, websiteUrl, businessType, serviceArea } = req.body;

    if (!businessName || !websiteUrl || !businessType) {
        return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    try {
        const effectiveServiceArea = serviceArea || businessName;
        const searchQuery = `${businessType} contractor in ${effectiveServiceArea}`;

        // === 1. GET GOOGLE MAPS DATA & FIND COMPETITOR ===
        console.log(`Finding business and competitor with query: "${searchQuery}"...`);
        const placesResponse = await mapsClient.textSearch({
            params: {
                query: searchQuery,
                key: process.env.GOOGLE_MAPS_API_KEY,
            },
        });

        const allResults = placesResponse.data.results;
        const userBusiness = allResults.find(r => r.name.toLowerCase().includes(businessName.toLowerCase().substring(0, 5))) || allResults[0];
        const topCompetitor = allResults.find(r => r.place_id !== userBusiness.place_id);

        const googleData = {
            rating: userBusiness.rating || 4.0,
            reviewCount: userBusiness.user_ratings_total || 0,
        };

        // === 2. CREATE MAP EMBED URL ===
        const mapEmbedUrl = `https://www.google.com/maps/embed/v1/search?key=${process.env.GOOGLE_MAPS_API_KEY}&q=${encodeURIComponent(searchQuery)}`;
        
        // === 3. SCRAPE COMPETITOR ADS ===
        let competitorAds = [];
        let topCompetitorData = null;
        if (topCompetitor) {
            const competitorDetails = await mapsClient.placeDetails({
                params: { place_id: topCompetitor.place_id, fields: ["name", "website"], key: process.env.GOOGLE_MAPS_API_KEY }
            });
            const competitorWebsite = competitorDetails.data.result.website;
            if (competitorWebsite) {
                topCompetitorData = { name: topCompetitor.name, website: competitorWebsite };
                const competitorDomain = new URL(competitorWebsite).hostname;
                competitorAds = await scrapeGoogleAds(competitorDomain);
            }
        }

        // === 4. GET DETAILED GEMINI ANALYSIS ===
        console.log("Sending final request to Gemini...");
        const geminiPrompt = `
            Analyze the following data for a local contractor named "${businessName}" targeting the "${effectiveServiceArea}" market. Their business model is "${businessType}". Their website is "${websiteUrl}".
            Their top competitor appears to be "${topCompetitorData?.name}". We found ${competitorAds.length} of their ads with the following content: ${JSON.stringify(competitorAds)}.

            Provide a detailed breakdown as a valid JSON object only. Do not add markdown formatting.
            The JSON object must have four keys: "scores", "topPriority", "competitorAdAnalysis", and "reviewSentiment".
            
            The "scores" object must contain a score from 0-100 for each of the following keys:
            - "painPointResonance": How well does the website's main headline speak to a customer's problem (e.g., "leaky roof") versus generic marketing language?
            - "ctaStrength": How strong and action-oriented is the main call-to-action button (e.g., "Get My Free Estimate" is strong, "Submit" is weak)?
            - "websiteHealth": Based on perceived speed, mobile-friendliness, and use of HTTPS.
            - "onPageSEO": Based on clear H1 and title tags that mention their service and the target market: "${effectiveServiceArea}".

            The "topPriority" key must be a string with your single most important, actionable recommendation, tailored for the "${effectiveServiceArea}" market.

            The "competitorAdAnalysis" key must be a string summarizing the themes and offers found in the competitor's ads. If no ads were found, state that and suggest a potential ad angle.
            
            The "reviewSentiment" key must be a string identifying the single biggest positive theme from the business's Google reviews (e.g., professionalism, quality, price). Base this on the public reviews for "${businessName}" in "${effectiveServiceArea}".
        `;

        const result = await model.generateContent(geminiPrompt);
        let responseText = result.response.text();
        responseText = responseText.replace(/```json\n|```/g, "");
        const geminiAnalysis = JSON.parse(responseText);

        // === 5. CALCULATE THE FINAL SCORE ===
        const scores = calculateFinalScore(googleData, geminiAnalysis.scores, businessType);

        // === 6. SEND THE COMPLETE ANALYSIS BACK TO THE FRONTEND ===
        res.json({
            success: true,
            ...scores,
            geminiAnalysis,
            topCompetitor: topCompetitorData,
            mapEmbedUrl: mapEmbedUrl
        });

    } catch (error) {
        console.error("Full analysis error:", error);
        res.status(500).json({ success: false, message: "An error occurred during the analysis." });
    }
});

// --- SCORING LOGIC FUNCTION ---
function calculateFinalScore(googleData, geminiScores, businessType) {
    const ratingScore = (googleData.rating / 5) * 100;
    const reviewScore = Math.min((googleData.reviewCount / 150), 1) * 100;
    
    const allScores = {
        rating: ratingScore,
        reviewVolume: reviewScore,
        ...geminiScores
    };
    
    let finalScore;
    if (businessType === 'specialty') {
        finalScore = Math.round(
            (allScores.rating * 0.20) + (allScores.reviewVolume * 0.15) + (allScores.painPointResonance * 0.20) +
            (allScores.ctaStrength * 0.05) + (allScores.websiteHealth * 0.15) + (allScores.onPageSEO * 0.15)
        );
    } else { // 'maintenance'
        finalScore = Math.round(
            (allScores.rating * 0.15) + (allScores.reviewVolume * 0.15) + (allScores.painPointResonance * 0.05) +
            (allScores.ctaStrength * 0.25) + (allScores.websiteHealth * 0.15) + (allScores.onPageSEO * 0.15)
        );
    }

    return {
        finalScore: Math.min(finalScore || 70, 99),
        detailedScores: {
            "Overall Rating": Math.round(allScores.rating),
            "Review Volume": Math.round(allScores.reviewVolume),
            "Pain Point Resonance": allScores.painPointResonance,
            "Call-to-Action Strength": allScores.ctaStrength,
            "Website Health": allScores.websiteHealth,
            "On-Page SEO": allScores.onPageSEO,
        }
    };
}

// --- START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Analysis server running on port ${PORT}`);
});