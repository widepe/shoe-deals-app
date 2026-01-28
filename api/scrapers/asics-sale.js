// api/scrapers/asics-sale.js
// FIXED - Uses Firecrawl actions/screenshot mode to bypass bot detection

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

function pickBestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== "string") return null;
  const candidates = srcset
    .split(",")
    .map((s) => s.trim())
    .map((entry) => entry.split(/\s+/)[0])
    .filter(Boolean);
  if (!candidates.length) return null;
  return candidates[candidates.length - 1];
}

function absolutizeAsicsUrl(url) {
  if (!url || typeof url !== "string") return null;
  url = url.replace(/&amp;/g, "&").trim();
  if (!url) return null;
  if (url.startsWith("data:")) return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.asics.com${url}`;
  return `https://www.asics.com/${url}`;
}

function buildAsicsImageFromProductUrl(productUrl) {
  if (!productUrl || typeof productUrl !== "string") return null;
  const m = productUrl.match(/ANA_([A-Za-z0-9]+)-([A-Za-z0-9]+)\.html/i);
  if (!m) return null;
  const style = m[1];
  const color = m[2];
  return `https://images.asics.com/is/image/asics/${style}_${color}_SR_RT_GLB?$zoom$`;
}

function detectShoeType(title, model) {
  const combined = ((title || "") + " " + (model || "")).toLowerCase();
  if (/\b(trail|trabuco|fujitrabuco|fuji|venture)\b/i.test(combined)) return "trail";
  if (/\b(track|spike|japan|metaspeed|magic speed)\b/i.test(combined)) return "track";
  return "road";
}

function normalizeGender(raw) {
  const g = String(raw || "").trim().toLowerCase();
  if (g === "mens" || g === "men" || g === "m") return "mens";
  if (g === "womens" || g === "women" || g === "w" || g === "ladies") return "womens";
  if (g === "unisex" || g === "u") return "unisex";
  return "unisex";
}

function parseMoneyFromText(text) {
  if (!text) return null;
  const m = String(text).match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractPrices($, $productLink) {
  let price = null;
  let salePrice = null;

  const linkText = $productLink.text();
  const parentText = $productLink.parent().text();
  
  const priceMatches = (linkText + " " + parentText).match(/\$\d+\.\d{2}/g);
  
  if (priceMatches && priceMatches.length >= 2) {
    const prices = priceMatches
      .map(p => parseFloat(p.replace("$", "")))
      .filter(n => Number.isFinite(n) && n > 0);
    
    if (prices.length >= 2) {
      prices.sort((a, b) => b - a);
      price = prices[0];
      salePrice = prices[1];
    }
  } else if (priceMatches && priceMatches.length === 1) {
    salePrice = parseFloat(priceMatches[0].replace("$", ""));
  }

  return { price, salePrice };
}

function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  const normalizedUrl = String(sourceUrl || "").toLowerCase();
  let gender = "unisex";

  if (normalizedUrl.includes("aa20106000") || normalizedUrl.includes("womens-clearance")) {
    gender = "womens";
  } else if (normalizedUrl.includes("aa10106000") || normalizedUrl.includes("mens-clearance")) {
    gender = "mens";
  } else if (normalizedUrl.includes("leaving-asics") || normalizedUrl.includes("aa60400001")) {
    gender = "unisex";
  }

  gender = normalizeGender(gender);

  console.log(`[ASICS] Processing URL: ${sourceUrl} -> Gender: ${gender}`);

  // Find product links
  const $productLinks = $('a[href*="/p/ANA_"]');
  
  console.log(`[ASICS] Found ${$productLinks.length} product links for ${gender}`);

  const seenUrls = new Set();

  $productLinks.each((_, el) => {
    const $link = $(el);

    let url = $link.attr("href");
    if (!url) return;
    
    url = absolutizeAsicsUrl(url);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);

    let title = $link.attr("aria-label") || $link.text().trim();
    
    title = title
      .replace(/Next slide/gi, "")
      .replace(/Previous slide/gi, "")
      .replace(/\bSale\b/gi, "")
      .replace(/\$\d+\.\d{2}/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title || title.length < 3) return;

    const modelMatch = title.match(/^([A-Z][A-Z\-\s\d]+?)(?=\s*$|Men's|Women's|Unisex|Sportstyle|Running|Tennis|Trail)/i);
    const model = modelMatch ? modelMatch[1].trim() : title.replace(/^ASICS\s+/i, "").trim();

    const { price, salePrice } = extractPrices($, $link);

    // Extract image
    let image = null;
    const $img = $link.find("img").first();
    
    if ($img.length > 0) {
      const srcset = $img.attr("srcset") || $img.attr("data-srcset") || $img.attr("data-lazy-srcset");
      image = pickBestFromSrcset(srcset);

      if (!image) {
        image = $img.attr("src") || $img.attr("data-src") || $img.attr("data-lazy-src");
      }
    }

    if (!image) {
      const $picture = $link.find("picture");
      if ($picture.length > 0) {
        const sourceSrcset = $picture.find("source[srcset]").first().attr("srcset");
        image = pickBestFromSrcset(sourceSrcset);
      }
    }

    // Check parent for images
    if (!image) {
      const $parent = $link.parent();
      const $parentImg = $parent.find("img").first();
      if ($parentImg.length > 0) {
        const srcset = $parentImg.attr("srcset") || $parentImg.attr("data-srcset");
        image = pickBestFromSrcset(srcset);
        if (!image) {
          image = $parentImg.attr("src") || $parentImg.attr("data-src");
        }
      }
    }

    image = absolutizeAsicsUrl(image);

    if (image && (image.startsWith("data:") || image.toLowerCase().includes("placeholder"))) {
      image = null;
    }

    if (image && image.includes("$variantthumbnail$")) {
      image = image.replace("$variantthumbnail$", "$zoom$");
    }

    if (!image && url) {
      const derived = buildAsicsImageFromProductUrl(url);
      if (derived) image = derived;
    }

    products.push({
      title,
      brand: "ASICS",
      model,
      salePrice: salePrice != null ? salePrice : null,
      price: price != null ? price : null,
      store: "ASICS",
      url,
      image: image || null,
      gender,
      shoeType: detectShoeType(title, model),
    });
  });

  return products;
}

async function scrapeAsicsUrlWithPagination(app, baseUrl, description) {
  console.log(`[ASICS] Scraping ${description}...`);

  try {
    const url = baseUrl.includes("?") ? `${baseUrl}&sz=100` : `${baseUrl}?sz=100`;
    console.log(`[ASICS] Fetching: ${url}`);

    // USE ACTIONS MODE to bypass bot detection
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html"],
      actions: [
        { type: "wait", milliseconds: 3000 },
        { type: "scroll", direction: "down" },
        { type: "wait", milliseconds: 2000 },
      ],
      timeout: 60000,
    });

    console.log(`[ASICS] Response received, HTML length: ${scrapeResult.html?.length || 0}`);

    const products = extractAsicsProducts(scrapeResult.html, baseUrl);

    const missingImages = products.filter((p) => !p.image).length;
    const missingPrices = products.filter((p) => !p.price || !p.salePrice).length;
    
    console.log(`[ASICS] ${description}: Found ${products.length} products`);
    console.log(`[ASICS]   - Missing images: ${missingImages}`);
    console.log(`[ASICS]   - Missing prices: ${missingPrices}`);

    return { success: true, products, count: products.length, url };
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return { success: false, products: [], count: 0, error: error.message, url: baseUrl };
  }
}

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  console.log("[ASICS] Starting scrape with browser actions...");

  const pages = [
    {
      url: "https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/",
      description: "Men's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/womens-clearance/c/aa20106000/running/shoes/",
      description: "Women's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/shoes/?prefn1=c_productGender&prefv1=Women%7CMen",
      description: "Last Chance Styles",
    },
  ];

  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];

    console.log(`[ASICS] Starting page ${i + 1}/${pages.length}: ${description}`);

    const result = await scrapeAsicsUrlWithPagination(app, url, description);
    results.push({
      page: description,
      success: result.success,
      count: result.count,
      error: result.error || null,
      url: result.url,
    });

    if (result.success) allProducts.push(...result.products);

    if (i < pages.length - 1) {
      console.log("[ASICS] Waiting 3 seconds before next page...");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // Deduplicate
  const uniqueProducts = [];
  const seenUrls = new Set();

  for (const product of allProducts) {
    if (!product.url) {
      uniqueProducts.push(product);
      continue;
    }
    if (!seenUrls.has(product.url)) {
      seenUrls.add(product.url);
      uniqueProducts.push(product);
    }
  }

  const missingImagesTotal = uniqueProducts.filter((p) => !p.image).length;
  const missingPricesTotal = uniqueProducts.filter((p) => !p.price || !p.salePrice).length;
  
  console.log(`[ASICS] Total unique products: ${uniqueProducts.length}`);
  console.log(`[ASICS]   - Missing images: ${missingImagesTotal}`);
  console.log(`[ASICS]   - Missing prices: ${missingPricesTotal}`);

  return { products: uniqueProducts, pageResults: results };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const start = Date.now();

  try {
    const { products: deals, pageResults } = await scrapeAllAsicsSales();

    const dealsByGender = { mens: 0, womens: 0, unisex: 0 };
    for (const d of deals) {
      const g = normalizeGender(d.gender);
      d.gender = g;
      dealsByGender[g] += 1;
    }

    const output = {
      lastUpdated: new Date().toISOString(),
      store: "ASICS",
      segments: ["Men's Clearance", "Women's Clearance", "Last Chance Styles"],
      totalDeals: deals.length,
      dealsByGender,
      pageResults,
      deals,
    };

    const blob = await put("asics-sale.json", JSON.stringify(output, null, 2), {
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
    console.error("[ASICS] Fatal error:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
