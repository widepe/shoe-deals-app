// api/daily-deals.js
const axios = require("axios");

// ============================================================================
// DATE-BASED SEEDED RANDOM FUNCTIONS
// ============================================================================
// These functions ensure that "random" selections stay the same all day long.
// 
// How it works:
// 1. Use today's date (e.g., "2026-01-09") as a seed
// 2. Convert date to a number (sum of character codes)
// 3. Generate "random" numbers based on this seed
// 4. Same seed = same "random" numbers = same deals all day
// 5. New day = new seed = new "random" numbers = new deals
//
// Why this matters:
// - Users see the same deals all day (no confusion when refreshing page)
// - Deals change automatically at midnight (no manual updates needed)
// - No database needed to remember which deals were selected
// - All users see the same deals (consistent experience)
// ============================================================================

// Simple seeded random number generator
// Same seed always produces same sequence of "random" numbers
function seededRandom(seed) {
  const x = Math.sin(seed++) * 10000;
  return x - Math.floor(x);
}

// Randomly sample from array using date-based seed
// Returns same results all day, different results each day
function getRandomSample(array, count) {
  // Use today's date as seed (YYYY-MM-DD format, changes at midnight UTC)
  const today = new Date().toISOString().split('T')[0]; // e.g., "2026-01-09"
  
  // Convert date string to number seed
  let seed = 0;
  for (let i = 0; i < today.length; i++) {
    seed += today.charCodeAt(i);
  }
  
  const copy = [...array];
  const picked = [];

  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const rng = seededRandom(seed + i);
    const idx = Math.floor(rng * copy.length);
    picked.push(copy[idx]);
    copy.splice(idx, 1);
  }

  return picked;
}

// Parse price fields that might be numbers or strings like "$99.88"
function parseMoney(value) {
  if (value === null || value === undefined) return NaN;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

function hasGoodImage(deal) {
  if (!deal || typeof deal.image !== "string") return false;
  const img = deal.image.trim();
  if (!img) return false;
  if (!/^https?:\/\//i.test(img)) return false;
  if (img.toLowerCase().includes("no-image")) return false;
  return true;
}

// "Discounted" = either numeric markdown OR a non–"Full Price" discount label
function isDiscounted(deal) {
  if (!deal) return false;

  const price = parseMoney(deal.price);
  const original = parseMoney(deal.originalPrice);

  const numericDiscount =
    Number.isFinite(price) &&
    Number.isFinite(original) &&
    original > price;

  if (numericDiscount) return true;

  if (typeof deal.discount === "string") {
    const txt = deal.discount.trim();
    if (!txt) return false;
    if (/full price/i.test(txt)) return false;
    return true;
  }

  return false;
}

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;

  const startedAt = Date.now();

  try {
    // FIXED: Now points to the consistent deals.json URL (no random suffix)
    const blobUrl =
      "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals.json";

    let dealsData;
    try {
      const response = await axios.get(blobUrl);
      dealsData = response.data;
    } catch (blobError) {
      console.error("[/api/daily-deals] Error fetching from blob:", {
        requestId,
        message: blobError.message,
      });
      return res.status(500).json({
        error: "Failed to load deals data",
        requestId,
      });
    }

    // Extract deals array from the response
    const allDeals = (dealsData && Array.isArray(dealsData.deals))
      ? dealsData.deals
      : (dealsData && dealsData.deals) || [];

    console.log("[/api/daily-deals] Loaded deals:", {
      requestId,
      total: allDeals.length,
      hasDealsField: !!dealsData?.deals,
    });

    // Filter for deals with discounts and images (quality pool)
    // ========================================================================
    // DAILY DEALS SELECTION STRATEGY
    // ========================================================================
    // Goal: Show 12 high-quality deals that change once per day (at midnight)
    //
    // Selection Method (4 + 4 + 4):
    // 1. Sort by HIGHEST PERCENTAGE OFF → take top 20 → RANDOMLY PICK 4 from those 20
    // 2. Sort by BIGGEST DOLLAR SAVINGS → take top 20 → RANDOMLY PICK 4 from those 20 (no duplicates)
    // 3. From all remaining deals → RANDOMLY PICK 4 (for variety/discovery)
    //
    // Why this approach:
    // - Guarantees quality: 8 deals come from top 20 pools (best discounts)
    // - Provides variety: Random selection within pools means different deals daily
    // - Ensures discovery: 4 completely random deals expose lesser-known deals
    // - No duplicates: Each step excludes previous selections
    // - Changes daily: Date-based random seed picks different deals each day
    // - Fair exposure: All top 20 deals get rotated through over time
    //
    // Example with 56 deals:
    // - Day 1: Picks deals #3, #7, #12, #18 from top 20% pool
    // - Day 2: Picks deals #1, #5, #14, #19 from top 20% pool (different!)
    //
    // Display order: All 12 shuffled randomly (same shuffle all day)
    // ========================================================================

    const qualityDeals = allDeals.filter(
      (d) => hasGoodImage(d) && isDiscounted(d) && d.originalPrice && d.price
    );

    // If we don't have enough quality deals, use all deals with images
    const workingPool = qualityDeals.length >= 12 
      ? qualityDeals 
      : allDeals.filter(hasGoodImage);

    // 1) TOP 20 BY PERCENTAGE OFF → Pick random 4
    const top20ByPercent = [...workingPool].sort((a, b) => {
      const pctA = a.originalPrice && a.price 
        ? ((a.originalPrice - a.price) / a.originalPrice) * 100 
        : 0;
      const pctB = b.originalPrice && b.price 
        ? ((b.originalPrice - b.price) / b.originalPrice) * 100 
        : 0;
      return pctB - pctA;
    }).slice(0, 20);
    const byPercent = getRandomSample(top20ByPercent, 4);

    // 2) TOP 20 BY DOLLAR SAVINGS → Pick random 4 (excluding already picked)
    const top20ByDollar = [...workingPool]
      .filter(d => !byPercent.includes(d))
      .sort((a, b) => {
        const savingsA = (a.originalPrice || 0) - (a.price || 0);
        const savingsB = (b.originalPrice || 0) - (b.price || 0);
        return savingsB - savingsA;
      })
      .slice(0, 20);
    const byDollar = getRandomSample(top20ByDollar, 4);

    // 3) 4 RANDOM from remaining (excluding already picked)
    const remaining = workingPool.filter(
      d => !byPercent.includes(d) && !byDollar.includes(d)
    );
    const randomPicks = getRandomSample(remaining, 4);

    // Combine all 12 deals and SHUFFLE them for random display order
    const selectedRaw = [...byPercent, ...byDollar, ...randomPicks];
    
    // Shuffle using the same date-based seed so order stays same all day
    const today = new Date().toISOString().split('T')[0];
    let shuffleSeed = 999; // Different seed than selection
    for (let i = 0; i < today.length; i++) {
      shuffleSeed += today.charCodeAt(i) * 7;
    }
    
    // Fisher-Yates shuffle with seed
    const shuffled = [...selectedRaw];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const rng = seededRandom(shuffleSeed + i);
      const j = Math.floor(rng * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    const selected = shuffled.map((deal) => {
      const price = parseMoney(deal.price);
      const original = parseMoney(deal.originalPrice);

      let discountLabel = deal.discount || null;

      // Compute % OFF if we have numeric markdown and no label
      if (!discountLabel && Number.isFinite(price) && Number.isFinite(original) && original > 0) {
        const pct = Math.round(100 * (1 - price / original));
        if (pct > 0) {
          discountLabel = `${pct}% OFF`;
        }
      }

      return {
        title: deal.title,
        price: Number.isFinite(price) ? price : null,
        originalPrice: Number.isFinite(original) ? original : null,
        discount: discountLabel,
        store: deal.store,
        url: deal.url,
        image: deal.image,
        brand: deal.brand,
        model: deal.model,
      };
    });

    const elapsedMs = Date.now() - startedAt;
    console.log("[/api/daily-deals] Response:", {
      requestId,
      elapsedMs,
      totalDeals: allDeals.length,
      discountedWithImages: discountedWithImages.length,
      withImagesOnly: withImagesOnly.length,
      poolReason,
      picked: selected.length,
    });

    return res.status(200).json({
      requestId,
      elapsedMs,
      totalDeals: allDeals.length,
      discountedWithImages: discountedWithImages.length,
      withImagesOnly: withImagesOnly.length,
      poolReason,
      deals: selected,
    });
  } catch (err) {
    console.error("[/api/daily-deals] Fatal error:", {
      requestId,
      message: err?.message || String(err),
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Unexpected error in daily deals endpoint",
      requestId,
    });
  }
};
