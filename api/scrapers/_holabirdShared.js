// /api/scrapers/_holabirdShared.js
const axios = require("axios");
const cheerio = require("cheerio");

const HOLABIRD_BASE = "https://www.holabirdsports.com";

/**
 * Minimal text cleanup.
 * Goal: extract usable text without trying to fully sanitize everything
 * (merge-deals does the heavier normalization/sanitization later).
 */
function normalizeText(input) {
  if (input == null) return "";
  return String(input).replace(/\s+/g, " ").trim();
}

/**
 * Hard reject strings that look like injected CSS/widget garbage.
 * This is the key upstream guard that prevents the "#review-stars..." bug.
 */
function looksLikeCssOrWidgetJunk(s) {
  const t = normalizeText(s);
  if (!t) return true;

  // Common junk patterns
  if (t.length < 4) return true;
  if (/^#review-stars-/i.test(t)) return true;
  if (/oke-sr-count/i.test(t)) return true;

  // CSS-ish signatures (we don't want to output these at all)
  if (t.includes("{") && t.includes("}") && t.includes(":")) return true;
  if (t.startsWith("@media") || t.startsWith(":root")) return true;
  if (/^#[-_a-z0-9]+/i.test(t)) return true;

  return false;
}

function absolutizeUrl(url, base = HOLABIRD_BASE) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;

  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base + u;

  return base.replace(/\/+$/, "") + "/" + u.replace(/^\/+/, "");
}

function pickLargestFromSrcset(srcset) {
  if (!srcset) return null;

  const parts = String(srcset)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  let best = null;
  let bestScore = -1;

  for (const part of parts) {
    const [url, desc] = part.split(/\s+/);
    if (!url) continue;

    let score = 0;
    const mW = desc?.match(/(\d+)w/i);
    const mX = desc?.match(/(\d+(?:\.\d+)?)x/i);

    if (mW) score = parseInt(mW[1], 10);
    else if (mX) score = Math.round(parseFloat(mX[1]) * 1000);

    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  }

  return best;
}

function findBestImageUrl($, $link, $container) {
  const candidates = [];

  function pushFromImg($img) {
    if (!$img || !$img.length) return;

    const src =
      $img.attr("data-src") || $img.attr("data-original") || $img.attr("src");

    const srcset = $img.attr("data-srcset") || $img.attr("srcset");
    const picked = pickLargestFromSrcset(srcset);

    if (picked) candidates.push(picked);
    if (src) candidates.push(src);
  }

  pushFromImg($link.find("img").first());
  pushFromImg($container.find("img").first());

  // sometimes there are multiple images; first valid wins
  $container.find("img").each((_, el) => pushFromImg($(el)));

  return (
    candidates
      .map((c) => absolutizeUrl(String(c || "").trim(), HOLABIRD_BASE))
      .filter(Boolean)[0] || null
  );
}

/**
 * Extract dollar amounts from tile text.
 * This is intentionally simple and "schema strict".
 */
function extractDollarAmounts(text) {
  if (!text) return [];
  const matches = String(text).match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return [];

  return matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter(Number.isFinite);
}

/**
 * NEW-SCHEMA STRICT:
 * returns { salePrice, price, valid }
 * - salePrice = lower price
 * - price = original/MSRP (higher price)
 */
function extractPricesFromTileText(tileText) {
  let prices = extractDollarAmounts(tileText).filter((p) => p >= 10 && p < 1000);

  // unique by cents
  prices = [...new Set(prices.map((p) => p.toFixed(2)))].map(Number);

  // Holabird tiles tend to have 2 prices; allow up to 4 for safety
  if (prices.length < 2 || prices.length > 4) return { valid: false };

  prices.sort((a, b) => b - a);

  const price = prices[0]; // higher
  const salePrice = prices[prices.length - 1]; // lower

  if (!(salePrice < price)) return { valid: false };

  const pct = ((price - salePrice) / price) * 100;
  if (pct < 5 || pct > 90) return { valid: false };

  return { salePrice, price, valid: true };
}

function extractBrandAndModel(title) {
  if (!title) return { brand: "Unknown", model: "" };

  const brands = [
    "Mizuno", "Saucony", "HOKA", "Brooks", "ASICS", "New Balance",
    "On", "Altra", "adidas", "Nike", "Puma", "Salomon", "Diadora",
    "K-Swiss", "Wilson", "Babolat", "HEAD", "Yonex", "Under Armour",
    "VEJA", "APL", "Merrell", "Teva", "Reebok", "Skechers", "Mount to Coast",
    "norda", "inov8", "OOFOS", "Birkenstock", "Kane Footwear", "LANE EIGHT"
  ];

  for (const brand of brands) {
    const regex = new RegExp(`\\b${brand}\\b`, "i");
    if (regex.test(title)) {
      const parts = title.split(regex);
      let model = parts.length > 1 ? parts[1].trim() : parts[0].trim();
      model = model.replace(/^[-:,\s]+/, "").trim();
      return { brand, model: model || title };
    }
  }

  const cleaned = title
    .replace(/^(Men's|Women's|Kids?|Youth|Junior|Unisex|Sale:?|New:?)\s+/gi, "")
    .trim();

  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) return { brand: parts[0], model: parts.slice(1).join(" ") };

  return { brand: "Unknown", model: title };
}

function detectGender(url, title) {
  const urlLower = (url || "").toLowerCase();
  const combined = (urlLower + " " + (title || "").toLowerCase()).trim();

  if (/gender_mens|\/mens[\/-]|men-/.test(urlLower)) return "mens";
  if (/gender_womens|\/womens[\/-]|women-/.test(urlLower)) return "womens";

  if (/\b(men'?s?|male)\b/i.test(combined)) return "mens";
  if (/\b(women'?s?|female|ladies)\b/i.test(combined)) return "womens";
  if (/\bunisex\b/i.test(combined)) return "unisex";

  return "unknown";
}

function detectShoeType(url, title) {
  const combined = ((url || "") + " " + (title || "")).toLowerCase();

  if (/\b(trail|speedgoat|peregrine|hierro|wildcat|terraventure|speedcross)\b/i.test(combined)) {
    return "trail";
  }
  if (/\b(track|spike|dragonfly|zoom.*victory|spikes?)\b/i.test(combined)) {
    return "track";
  }
  return "road";
}

function randomDelay(min = 250, max = 700) {
  const wait = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, wait));
}

/**
 * Scrapes a Holabird "collections/shoe-deals" collection.
 * Outputs NEW SCHEMA STRICT deals:
 * {title, brand, model, salePrice, price, store, url, image, gender, shoeType}
 */
async function scrapeHolabirdCollection({
  collectionUrl,
  maxPages = 50,
  stopAfterEmptyPages = 1,
}) {
  const deals = [];
  const seen = new Set();
  let emptyPages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = collectionUrl.includes("?")
      ? `${collectionUrl}&page=${page}`
      : `${collectionUrl}?page=${page}`;

    const resp = await axios.get(pageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(resp.data);
    let found = 0;

    $('a[href*="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href");
      if (!href || href.includes("#")) return;

      const productUrl = absolutizeUrl(href);
      if (!productUrl || seen.has(productUrl)) return;

      const $container = $link.closest("li, article, div").first();

      // Use raw text (no heavy sanitizing). We only need dollars for extraction.
      const containerText = normalizeText($container.text());
      if (!containerText || !containerText.includes("$")) return;

      // Title extraction (must be real text, not widget junk)
      let title =
        normalizeText($link.text()) ||
        normalizeText($link.find("img").first().attr("alt")) ||
        normalizeText($link.attr("title"));

      if (!title || looksLikeCssOrWidgetJunk(title)) return;

      const prices = extractPricesFromTileText(containerText);
      if (!prices.valid) return;

      const { brand, model } = extractBrandAndModel(title);

      deals.push({
        title,
        brand,
        model,
        salePrice: prices.salePrice,
        price: prices.price,
        store: "Holabird Sports",
        url: productUrl,
        image: findBestImageUrl($, $link, $container),
        gender: detectGender(productUrl, title),
        shoeType: detectShoeType(productUrl, title),
      });

      seen.add(productUrl);
      found++;
    });

    if (found === 0) {
      emptyPages++;
      if (emptyPages >= stopAfterEmptyPages) break;
    } else {
      emptyPages = 0;
    }

    await randomDelay();
  }

  return deals;
}

function dedupeByUrl(deals) {
  const out = [];
  const seen = new Set();
  for (const d of deals || []) {
    if (!d?.url || seen.has(d.url)) continue;
    seen.add(d.url);
    out.push(d);
  }
  return out;
}

module.exports = {
  scrapeHolabirdCollection,
  dedupeByUrl,
};
