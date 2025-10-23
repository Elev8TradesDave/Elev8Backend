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

