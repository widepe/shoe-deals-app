// api/daily-deals.js
const axios = require("axios");

// Simple random sampler without modifying original array
function getRandomSample(array, count) {
  const copy = [...array];
  const picked = [];

  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * copy.length);
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

// Robustly extract the deals array from the blob response
function extractDeals(dealsData) {
  // Case 1: { deals: [...] }
  if (dealsData && Array.isArray(dealsData.deals)) {
    return dealsData.deals;
  }

  // Case 2: [ { deals: [...] } ]
  if (Array.isArray(dealsData) && dealsData.length > 0 && Array.isArray(dealsData[0].deals)) {
    return dealsData[0].deals;
  }

  return [];
}

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;

  const startedAt = Date.now();

  try {
    const blobUrl =
      "https://v3gjlrmpc76mymfc.public.blob.vercel-storage.com/deals-xYNKTRtjMYCwJbor5T63ZCNKf6cFjE.json";

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

    const allDeals = extractDeals(dealsData);
    console.log("[/api/daily-deals] Loaded deals:", {
      requestId,
      rawType: typeof dealsData,
      isArray: Array.isArray(dealsData),
      total: allDeals.length,
    });

    // ✅ Only deals with:
    //  - a real image URL
    //  - a real markdown (originalPrice > price)
    const discountedWithImages = allDeals.filter((d) => {
      if (!d) return false;

      // Image checks
      if (typeof d.image !== "string") return false;
      const img = d.image.trim();
      if (!img) return false;
      if (!/^https?:\/\//i.test(img)) return false;
      if (img.toLowerCase().includes("no-image")) return false;

      // Price checks
      const price = parseMoney(d.price);
      const original = parseMoney(d.originalPrice);

      if (!Number.isFinite(price) || !Number.isFinite(original)) return false;

      // Must actually be discounted
      if (!(original > price)) return false;

      return true;
    });

    const selectedRaw = getRandomSample(discountedWithImages, 8);

    // Normalize and enrich for the client
    const selected = selectedRaw.map((deal) => {
      const price = parseMoney(deal.price);
      const original = parseMoney(deal.originalPrice);

      let discountLabel = deal.discount || null;
      if (!discountLabel && Number.isFinite(price) && Number.isFinite(original) && original > 0) {
        const pct = Math.round(100 * (1 - price / original));
        if (pct > 0) {
          discountLabel = `${pct}% OFF`;
        }
      }

      return {
        title: deal.title,
        price,
        originalPrice: original,
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
      picked: selected.length,
    });

    return res.status(200).json({
      requestId,
      elapsedMs,
      totalDeals: allDeals.length,
      totalDiscountedWithImages: discountedWithImages.length,
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
