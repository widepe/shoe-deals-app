// api/scrapers/als-sale.js
// Scrapes ALS Men's + Women's running shoes (all pages) using axios+cheerio
// Mirrors ASICS output shape and blob behavior
//
// STRICT RULES:
// - Only include products with exactly ONE original price and ONE sale price
// - Skip ranges like "$81.99 - $131.99"
// - Skip if missing sale price
// - Original price = higher of the two, sale price = lower of the two
//
// Outputs 10-field schema per deal:
// { title, brand, model, salePrice, price, store, url, image, gender, shoeType }
//
// Saves blob: als-sale.json (public, stable name)

const axios = require("axios");
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

const STORE = "ALS";
const BASE = "https://www.als.com";

const MEN_BASE_URL =
  "https://www.als.com/footwear/men-s-footwear/men-s-running-shoes?filter.category-1=footwear&filter.category-2=men-s-footwear&filter.category-3=men-s-running-shoes&sort=discount%3Adesc";
const WOMEN_BASE_URL =
  "https://www.als.com/footwear/women-s-footwear/women-s-running-shoes?filter.category-1=footwear&filter.category-2=women-s-footwear&filter.category-3=women-s-running-shoes&sort=discount%3Adesc";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absolutizeAlsUrl(url) {
  if (!url || typeof url !== "string") return null;
  url = url.replace(/&amp;/g, "&").trim();
  if (!url) return null;
  if (url.startsWith("data:")) return null;

  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${BASE}${url}`;
  return `${BASE}/${url}`;
}

function parseSinglePrice(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, " ").trim();

  // Range => invalid (we don't want it)
  if (t.includes("-")) return null;

  const m = t.replace(/,/g, "").match(/\$([\d]+(?:\.\d{2})?)/);
  if (!m) return null;

  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractTwoPricesStrict($container) {
  const text = $container.text().replace(/\s+/g, " ").trim();
  if (!text) return { price: null, salePrice: null };

  // If any explicit range pattern exists, skip
  if (/\$\s*\d+(?:\.\d{2})?\s*-\s*\$\s*\d+(?:\.\d{2})?/.test(text)) {
    return { price: null, salePrice: null };
  }

  const matches = text.match(/\$\s*\d+(?:\.\d{2})?/g) || [];
  const seen = new Set();
  const nums = [];

  for (const raw of matches) {
    const n = parseSinglePrice(raw);
    if (n == null) continue;
    const key = String(n);
    if (seen.has(key)) continue;
    seen.add(key);
    nums.push(n);
  }

  // Strict: must be exactly 2 distinct prices
  if (nums.length !== 2) return { price: null, salePrice: null };

  const hi = Math.max(nums[0], nums[1]);
  const lo = Math.min(nums[0], nums[1]);

  // Must be an actual sale
  if (!(lo < hi)) return { price: null, salePrice: null };

  return { price: hi, salePrice: lo };
}

function cleanTitle(title) {
  return (title || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitBrandModel(title) {
  const t = cleanTitle(title);
  if (!t) return { brand: null, model: null };

  const brand = t.split(" ")[0];
  let model = t.replace(new RegExp("^" + brand + "\\s+", "i"), "").trim();
  model = model.replace(/\s+-\s+(men's|women's)\s*$/i, "").trim();

  return { brand, model: model || null };
}

function detectShoeTypeFromTitle(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("track") || t.includes("spike")) return "track";
  return "road";
}

/**
 * Extract deals from ALS listing page HTML.
 * Returns: { deals, tileCount } so pagination doesn't stop early
 */
function extractAlsDealsFromListing(html, gender) {
  const $ = cheerio.load(html);
  const deals = [];

  // Product pages commonly end with "/p" on ALS (listing tiles link there)
  const $links = $('a[href$="/p"]').filter((_, a) => {
    const href = $(a).attr("href") || "";
    const text = cleanTitle($(a).text());
    if (!text || text.length < 5) return false;
    if (href.includes("help.als.com")) return false;
    return true;
  });

  const tileCount = $links.length;

  $links.each((_, a) => {
    const $a = $(a);
    const title = cleanTitle($a.text());
    const url = absolutizeAlsUrl($a.attr("href"));

    if (!title || !url) return;

    // Find a card-like container around link
    let $card =
      $a.closest('div[class*="product"], li[class*="product"], article').first();
    if (!$card || !$card.length) $card = $a.parent();

    // Image
    let image =
      $card.find("img").first().attr("src") ||
      $card.find("img").first().attr("data-src") ||
      $card.find("img").first().attr("data-lazy-src") ||
      null;

    image = absolutizeAlsUrl(image);

    // Prices (strict)
    const { price, salePrice } = extractTwoPricesStrict($card);
    if (!price || !salePrice) return;

    const { brand, model } = splitBrandModel(title);
    if (!brand || !model) return;

    deals.push({
      title,
      brand,
      model,
      salePrice,
      price,
      store: STORE,
      url,
      image: image || null,
      gender, // "mens" or "womens"
      shoeType: detectShoeTypeFromTitle(title),
    });
  });

  // Deduplicate by URL within the page
  const unique = [];
  const seen = new Set();
  for (const d of deals) {
    if (!d.url) continue;
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }

  return { deals: unique, tileCount };
}

async function fetchHtml(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 45000,
  });
  return resp.data;
}

function withPageParam(baseUrl, page) {
  return baseUrl.includes("?") ? `${baseUrl}&page=${page}` : `${baseUrl}?page=${page}`;
}

async function scrapeAlsCategoryAllPages(baseUrl, gender, description) {
  const pageResults = [];
  const allDeals = [];
  const seenUrls = new Set();

  const MAX_PAGES = 60; // safety cap

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = withPageParam(baseUrl, page);
    const pageStart = Date.now();

    try {
      const html = await fetchHtml(pageUrl);
      const { deals, tileCount } = extractAlsDealsFromListing(html, gender);

      let newCount = 0;
      for (const d of deals) {
        if (d.url && !seenUrls.has(d.url)) {
          seenUrls.add(d.url);
          allDeals.push(d);
          newCount++;
        }
      }

      const duration = Date.now() - pageStart;

      pageResults.push({
        page: `${description} (page=${page})`,
        success: true,
        count: deals.length,
        error: null,
        url: pageUrl,
        // keep compatibility with your earlier logging
        newCount,
        durationMs: duration,
      });

      // Stop when there are no tiles (true end) OR no new URLs (repeat/loop)
      if (tileCount === 0 || newCount === 0) break;

      await sleep(800);
    } catch (err) {
      pageResults.push({
        page: `${description} (page=${page})`,
        success: false,
        count: 0,
        newCount: 0,
        error: err.message || String(err),
        url: pageUrl,
      });
      break;
    }
  }

  return { deals: allDeals, pageResults };
}

async function scrapeAllAlsSales() {
  console.log("[ALS] Starting scrape of all pages (sequential)...");

  const results = [];
  const allDeals = [];

  const pages = [
    { url: MEN_BASE_URL, gender: "mens", description: "Men's Running Shoes" },
    { url: WOMEN_BASE_URL, gender: "womens", description: "Women's Running Shoes" },
  ];

  for (let i = 0; i < pages.length; i++) {
    const { url, gender, description } = pages[i];

    console.log(`[ALS] Starting category ${i + 1}/${pages.length}: ${description}`);

    const result = await scrapeAlsCategoryAllPages(url, gender, description);
    results.push(...result.pageResults);
    allDeals.push(...result.deals);

    if (i < pages.length - 1) {
      console.log("[ALS] Waiting 1.2s before next category...");
      await sleep(1200);
    }
  }

  // Deduplicate across categories by URL
  const unique = [];
  const seen = new Set();
  for (const d of allDeals) {
    if (!d.url) continue;
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    unique.push(d);
  }

  console.log(`[ALS] Total unique products: ${unique.length}`);
  return { deals: unique, pageResults: results };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const { deals, pageResults } = await scrapeAllAlsSales();

    const output = {
      lastUpdated: new Date().toISOString(),
      store: STORE,
      segments: ["Men's Running Shoes", "Women's Running Shoes"],
      totalDeals: deals.length,
      dealsByGender: {
        mens: deals.filter((d) => d.gender === "mens").length,
        womens: deals.filter((d) => d.gender === "womens").length,
        unisex: deals.filter((d) => d.gender === "unisex").length,
      },
      pageResults,
      deals,
    };

    const blob = await put("als-sale.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: output.dealsByGender,
      pageResults,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error("[ALS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
