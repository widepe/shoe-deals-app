// api/scrape-asics.js
// Vercel Serverless Function
//
// Purpose: Scrape ASICS sale/listing pages and return normalized deals.
// Focus: robust image extraction (picture/source srcset, img srcset, lazy attrs)

const axios = require("axios");
const cheerio = require("cheerio");

/**
 * Pick the "best" candidate from a srcset string.
 * Example srcset: "https://.../img1.jpg 200w, https://.../img2.jpg 800w"
 * We usually want the last URL (largest).
 */
function pickBestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== "string") return null;

  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .map((entry) => entry.split(/\s+/)[0]) // URL part
    .filter(Boolean);

  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

function absolutizeAsicsUrl(url) {
  if (!url) return null;
  if (typeof url !== "string") return null;
  if (url.startsWith("data:")) return null;

  // handle HTML entities
  url = url.replace(/&amp;/g, "&");

  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `https://www.asics.com${url}`;
  return `https://www.asics.com/${url}`;
}

/**
 * Extracts a likely-correct product image URL from a product tile.
 * Checks:
 *  1) picture > source[srcset]/[data-srcset]
 *  2) img[srcset]/[data-srcset]/[data-lazy-srcset]
 *  3) img[src]/[data-src]/[data-lazy-src]/[data-original]
 */
function extractAsicsImageFromTile($product, $) {
  // 1) picture/source srcset
  const sourceSrcset =
    $product.find("picture source[srcset]").first().attr("srcset") ||
    $product.find("picture source[data-srcset]").first().attr("data-srcset");

  let image = pickBestFromSrcset(sourceSrcset);

  // 2) img srcset (and lazy variants)
  if (!image) {
    const $img = $product.find("img").first();
    const imgSrcset =
      $img.attr("srcset") ||
      $img.attr("data-srcset") ||
      $img.attr("data-lazy-srcset");

    image = pickBestFromSrcset(imgSrcset);
  }

  // 3) fallback to img src / lazy-src
  if (!image) {
    const $img = $product.find("img").first();
    image =
      $img.attr("src") ||
      $img.attr("data-src") ||
      $img.attr("data-lazy-src") ||
      $img.attr("data-original") ||
      null;
  }

  image = absolutizeAsicsUrl(image);

  // Skip common placeholders
  if (image && /placeholder/i.test(image)) image = null;

  // If ASICS uses variantthumbnail -> upgrade to zoom when present
  if (image && image.includes("$variantthumbnail$")) {
    image = image.replace("$variantthumbnail$", "$zoom$");
  }

  return image;
}

/**
 * Utility: best-effort parse price from text like "$89.95"
 */
function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[,]/g, "").trim();
  const m = cleaned.match(/(\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch HTML with browser-ish headers (helps for some CDNs)
 */
async function fetchHtml(url) {
  const resp = await axios.get(url, {
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  return resp.data;
}

/**
 * Main extraction logic. This is intentionally conservative: it tries common tile selectors.
 * If your ASICS page structure differs, adjust TILE_SELECTORS.
 */
function extractAsicsProducts(html, { sourceUrl, storeName = "ASICS" } = {}) {
  const $ = cheerio.load(html);

  // These are *guesses* that work on many ecommerce PLPs.
  // If your current file already has a known selector that finds the right tiles,
  // replace TILE_SELECTORS with your known selector.
  const TILE_SELECTORS = [
    '[data-testid*="product-tile"]',
    '[class*="product-tile"]',
    '[class*="ProductTile"]',
    'li[class*="product"]',
    'div[class*="product"]',
    'article',
  ];

  let $tiles = $();
  for (const sel of TILE_SELECTORS) {
    const found = $(sel);
    if (found.length >= 8) {
      $tiles = found;
      break;
    }
  }

  // If nothing matched well, just take a broad fallback
  if (!$tiles.length) {
    $tiles = $("body").find("li, div, article");
  }

  const results = [];
  const seen = new Set();

  $tiles.each((_, el) => {
    const $product = $(el);

    // URL (try first link that looks like a PDP)
    let href =
      $product.find('a[href*="/"]').first().attr("href") ||
      $product.find("a").first().attr("href") ||
      null;

    href = absolutizeAsicsUrl(href);

    // Basic title (try common patterns)
    const title =
      $product.find("a[title]").first().attr("title") ||
      $product.find('[data-testid*="product-name"]').first().text() ||
      $product.find('[class*="product-name"]').first().text() ||
      $product.find("h2, h3").first().text() ||
      "";

    const cleanTitle = String(title).replace(/\s+/g, " ").trim();

    // Skip junk nodes
    if (!cleanTitle || cleanTitle.length < 3) return;

    // Image (this is the main fix)
    const image = extractAsicsImageFromTile($product, $);

    // Price: look for sale/current and original/strike-through
    const priceText =
      $product.find('[data-testid*="price"]').first().text() ||
      $product.find('[class*="price"]').first().text() ||
      "";

    // Try to detect original vs current by scanning for two prices
    const allPriceText = String(priceText)
      .replace(/\s+/g, " ")
      .trim();

    // Extract all $xx.xx occurrences
    const priceMatches = allPriceText.match(/\$[0-9]+(?:\.[0-9]{1,2})?/g) || [];
    const numericPrices = priceMatches
      .map((p) => parsePrice(p))
      .filter((n) => n !== null);

    let price = null;
    let originalPrice = null;

    if (numericPrices.length === 1) {
      price = numericPrices[0];
    } else if (numericPrices.length >= 2) {
      // Heuristic: lowest is current, highest is original
      const sorted = [...numericPrices].sort((a, b) => a - b);
      price = sorted[0];
      originalPrice = sorted[sorted.length - 1];
      if (originalPrice === price) originalPrice = null;
    }

    // Very light de-dupe (by href+title)
    const key = `${href || ""}::${cleanTitle}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({
      title: cleanTitle,
      brand: "ASICS",
      model: cleanTitle.replace(/^ASICS\s+/i, "").trim() || cleanTitle,
      price,
      originalPrice,
      store: storeName,
      url: href || sourceUrl || null,
      image: image || null,
      discount: null,
      scrapedAt: new Date().toISOString(),
    });
  });

  return results;
}

// Vercel handler
module.exports = async function handler(req, res) {
  try {
    // You can override with ?url=... if you want to test different pages quickly
    const url =
      (req.query && req.query.url) ||
      "https://www.asics.com/us/en-us/sale/c/as-sal"; // default example

    const html = await fetchHtml(url);
    const deals = extractAsicsProducts(html, { sourceUrl: url, storeName: "ASICS" });

    res.status(200).json({
      success: true,
      count: deals.length,
      url,
      deals,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
};
