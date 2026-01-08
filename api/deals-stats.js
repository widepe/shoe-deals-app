// api/deals-stats.js
//
// Returns aggregate stats about all scraped deals:
//
// {
//   totalDeals: number,
//   dealsWithImages: number,
//   off10OrMore: number,
//   off25OrMore: number,
//   off50OrMore: number
// }

const { get } = require("@vercel/blob");

function computeDiscountPercent(deal) {
  // Prefer price + originalPrice
  const price = Number(deal.price);
  const original = deal.originalPrice != null ? Number(deal.originalPrice) : NaN;

  if (
    Number.isFinite(price) &&
    Number.isFinite(original) &&
    original > 0 &&
    price < original
  ) {
    const pct = ((original - price) / original) * 100;
    return Math.round(pct);
  }

  // Fallback: numeric discountPercent field
  if (typeof deal.discountPercent === "number" && deal.discountPercent > 0) {
    return Math.round(deal.discountPercent);
  }

  // Fallback: string discount like "-23%"
  if (typeof deal.discount === "string") {
    const m = deal.discount.match(/(\d+(?:\.\d+)?)%/);
    if (m) {
      const pct = Number(m[1]);
      if (Number.isFinite(pct) && pct > 0) {
        return Math.round(pct);
      }
    }
  }

  return 0;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // IMPORTANT: this must match what scrape-daily.js writes:
    //   put("deals.json", JSON.stringify(payload), { access: "public" })
    const { blob } = await get("deals.json");

    if (!blob || !blob.url) {
      return res.status(500).json({ error: "Could not locate deals blob" });
    }

    const resp = await fetch(blob.url);
    if (!resp.ok) {
      return res.status(500).json({
        error: "Failed to fetch deals JSON from blob",
        status: resp.status
      });
    }

    const json = await resp.json();

    // Support either [deal, deal, ...] or { deals: [...] }
    const deals = Array.isArray(json) ? json : (json.deals || []);
    const totalDeals = deals.length;

    const dealsWithImages = deals.filter(
      (d) => typeof d.image === "string" && d.image.trim().length > 0
    ).length;

    const withValidDiscount = deals.filter(
      (d) => computeDiscountPercent(d) > 0
    );

    const off10OrMore = withValidDiscount.filter(
      (d) => computeDiscountPercent(d) >= 10
    ).length;

    const off25OrMore = withValidDiscount.filter(
      (d) => computeDiscountPercent(d) >= 25
    ).length;

    const off50OrMore = withValidDiscount.filter(
      (d) => computeDiscountPercent(d) >= 50
    ).length;

    return res.status(200).json({
      totalDeals,
      dealsWithImages,
      off10OrMore,
      off25OrMore,
      off50OrMore
    });
  } catch (err) {
    console.error("[api/deals-stats] Error:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err?.message || String(err)
    });
  }
};
