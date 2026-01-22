const { put } = require("@vercel/blob");
const axios = require("axios");
const cheerio = require("cheerio");

const MENS_ROAD = "https://www.holabirdsports.com/collections/shoe-deals/Gender_Mens+Type_Running-Shoes+";

function sanitizeText(input) {
  if (input == null) return "";
  let s = String(input).trim();
  if (!s) return "";

  if (
    /{[^}]*}/.test(s) &&
    /(margin|display|font-size|padding|color|background|line-height)\s*:/i.test(s)
  ) {
    return "";
  }

  if (s.includes("<")) {
    s = s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
    s = s.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
    s = s.replace(/<[^>]+>/g, " ");
  }

  s = s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  s = s.replace(/\s+/g, " ").trim();

  if (!s || s.length < 4) return "";

  return s;
}

function absolutizeUrl(url, base = "https://www.holabirdsports.com") {
  if (!url) return null;
  let u = String(url).trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return base + u;
  return base + "/" + u.replace(/^\/+/, "");
}

function extractPricesFromText(fullText) {
  const matches = String(fullText).match(/\$\s*[\d,]+(?:\.\d{1,2})?/g);
  if (!matches) return { salePrice: null, originalPrice: null, valid: false };

  let prices = matches
    .map((m) => parseFloat(m.replace(/[$,\s]/g, "")))
    .filter((n) => Number.isFinite(n) && n >= 10 && n < 1000);

  prices = [...new Set(prices.map((p) => p.toFixed(2)))].map((s) => parseFloat(s));

  if (prices.length < 2) return { salePrice: null, originalPrice: null, valid: false };
  if (prices.length > 4) return { salePrice: null, originalPrice: null, valid: false };

  prices.sort((a, b) => b - a);

  const original = prices[0];
  const sale = prices[prices.length - 1];

  if (!(sale < original)) return { salePrice: null, originalPrice: null, valid: false };

  const pct = ((original - sale) / original) * 100;
  if (pct < 5 || pct > 90) return { salePrice: null, originalPrice: null, valid: false };

  return { salePrice: sale, originalPrice: original, valid: true };
}

function findBestImageUrl($, $link, $container) {
  const candidates = [];

  function pushFromImg($imgEl) {
    if (!$imgEl || !$imgEl.length) return;
    const src = $imgEl.attr("data-src") || $imgEl.attr("data-original") || $imgEl.attr("src");
    const srcset = $imgEl.attr("data-srcset") || $imgEl.attr("srcset");

    if (srcset) {
      const parts = String(srcset).split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        const url = lastPart.split(/\s+/)[0];
        if (url) candidates.push(url);
      }
    }
    if (src) candidates.push(src);
  }

  if ($link && $link.find) pushFromImg($link.find("img").first());
  if ($container && $container.find) pushFromImg($container.find("img").first());

  const abs = candidates
    .map((c) => (c ? String(c).trim() : ""))
    .filter(Boolean)
    .map((c) => absolutizeUrl(c));

  return abs[0] || null;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();

  try {
    const deals = [];
    const seen = new Set();

    const resp = await axios.get(MENS_ROAD, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(resp.data);

    $('a[href*="/products/"]').each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href");

      if (!href || !href.includes("/products/")) return;

      const productUrl = absolutizeUrl(href);
      if (!productUrl || seen.has(productUrl)) return;

      const $container = $link.closest("li, article, div").first();
      const containerText = sanitizeText($container.text());

      if (!containerText || !containerText.includes("$")) return;

      let title =
        sanitizeText($link.find("img").first().attr("alt")) ||
        sanitizeText($container.find("h2,h3,[class*='title'],[class*='name']").first().text()) ||
        sanitizeText($link.text());

      if (!title) return;
      if (/review-stars|oke-sr-count/i.test(title)) return;

      const { salePrice, originalPrice, valid } = extractPricesFromText(containerText);
      if (!valid || salePrice == null || originalPrice == null) return;

      const image = findBestImageUrl($, $link, $container);

      seen.add(productUrl);

      deals.push({
        title,
        store: "Holabird Sports",
        price: salePrice,
        originalPrice,
        url: productUrl,
        image: image || null,
        scrapedAt: new Date().toISOString(),
      });
    });

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "Holabird Sports",
      segment: "mens-road",
      totalDeals: deals.length,
      deals: deals,
    };

    const blob = await put("holabird-mens-road.json", JSON.stringify(output, null, 2), {
      access: "public",
      addRandomSuffix: false,
    });

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
