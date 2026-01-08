// api/daily-deals.js
// Return 8 "daily deals" chosen pseudo-randomly from the scraped blob.
// Only uses deals that have an image.

const axios = require("axios");

// Use the SAME blob URL as search.js
const BLOB_URL =
  "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals-xYNKTRtjMYCwJbor5T63ZCNKf6cFjE.json";

// Simple string -> integer hash
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

// Deterministic PRNG (mulberry32) so the same day gives the same 8 shoes
function createRng(seed) {
  return function mulberry32() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDailyRandom(deals, count) {
  if (!deals.length) return [];

  // One seed per calendar date, so all visitors see the same 8 that day
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const seed = hashString(today);
  const rng = createRng(seed);

  const copy = deals.slice();

  // Fisher–Yates shuffle using our RNG
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy.slice(0, Math.min(count, copy.length));
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const requestId = `daily_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;

  try {
    console.log("[/api/daily-deals] Request:", { requestId });

    const response = await axios.get(BLOB_URL);
    const dealsData = response.data || {};
    const allDeals = Array.isArray(dealsData.deals) ? dealsData.deals : [];

    console.log("[/api/daily-deals] Loaded deals:", {
      total: allDeals.length,
      lastUpdated: dealsData.lastUpdated || "unknown",
    });

    // Only keep deals that have an image URL
    const dealsWithImages = allDeals.filter(
      (d) =>
        d &&
        typeof d.image === "string" &&
        d.image.trim() &&
        typeof d.url === "string" &&
        d.url.trim()
    );

    console.log("[/api/daily-deals] Deals with images:", {
      total: dealsWithImages.length,
    });

    const dailyDeals = pickDailyRandom(dealsWithImages, 8);

    console.log("[/api/daily-deals] Returning daily deals:", {
      count: dailyDeals.length,
      requestId,
    });

    return res.status(200).json({
      requestId,
      lastUpdated: dealsData.lastUpdated || null,
      totalAvailable: dealsWithImages.length,
      totalReturned: dailyDeals.length,
      deals: dailyDeals,
    });
  } catch (err) {
    console.error("[/api/daily-deals] Error:", {
      requestId,
      message: err?.message || String(err),
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Failed to load daily deals",
      requestId,
    });
  }
};
