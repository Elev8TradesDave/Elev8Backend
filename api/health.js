// api/health.js - tiny, instant health check (no Express)
module.exports = (_req, res) => {
  res.status(200).json({
    ok: true,
    mapsKeyPresent: !!process.env.GOOGLE_MAPS_API_KEY,
    embedKeyPresent: !!process.env.GOOGLE_MAPS_EMBED_KEY,
    geminiKeyPresent: !!process.env.GEMINI_API_KEY,
    env: process.env.NODE_ENV || "unknown",
  });
};
