// api/scrapers/asics-sale.js
// Scrapes 3 ASICS sale pages using Firecrawl and writes asics-sale.json to Vercel Blob.
//
// Key fixes (for your 0-results problem):
// ✅ onlyMainContent:false (default true can drop ecommerce grids)  :contentReference[oaicite:2]{index=2}
// ✅ actions: wait for selector (ensures grid exists before scrape) :contentReference[oaicite:3]{index=3}
// ✅ maxAge:0 (avoid cached empty response)                         :contentReference[oaicite:4]{index=4}
// ✅ optional debug HTML blobs when ASICS_DEBUG_HTML=1

const FirecrawlApp = require("@mendable/firecrawl-js").default;
const cheerio = require("cheerio");
const { put } = require("@vercel/blob");

/** ---------------- Helpers ---------------- **/

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
  if (/\b(trail|trabuco|fujitrabuco|fuji)\b/i.test(combined)) return "trail";
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

function extractPricesFromTile($product, $) {
  const originalCandidates = [
    $product
      .find(
        '[class*="strike"], [class*="Strike"], [class*="was"], [class*="Was"], [class*="list"], [class*="List"]'
      )
      .toArray(),
    $product.find('[data-testid*="list"], [data-testid*="was"], [data-testid*="original"]').toArray(),
    $product.find('[aria-label*="was"], [aria-label*="Was"]').toArray(),
  ].flat();

  let price = null;
  for (const el of originalCandidates) {
    const v = parseMoneyFromText($(el).text());
    if (v != null) {
      price = v;
      break;
    }
  }

  const saleCandidates = [
    $product.find('[class*="sale"], [class*="Sale"], [class*="now"], [class*="Now"]').toArray(),
    $product.find('[data-testid*="sale"], [data-testid*="now"]').toArray(),
    $product.find('[aria-label*="now"], [aria-label*="Now"], [aria-label*="sale"], [aria-label*="Sale"]').toArray(),
  ].flat();

  let salePrice = null;
  for (const el of saleCandidates) {
    const v = parseMoneyFromText($(el).text());
    if (v != null) {
      salePrice = v;
      break;
    }
  }

  if (price != null && salePrice != null) {
    if (salePrice < price) return { price, salePrice };
    price = null;
    salePrice = null;
  }

  const productText = $product.text();
  const matches = productText.match(/\$(\d+(?:\.\d{2})?)/g);

  if (matches && matches.length >= 2) {
    const nums = matches.map((m) => parseFloat(m.replace("$", ""))).filter((n) => Number.isFinite(n));
    const p = nums[0] ?? null;
    const s = nums[1] ?? null;
    if (p != null && s != null && s < p) return { price: p, salePrice: s };
  }

  if (matches && matches.length === 1) {
    const only = parseFloat(matches[0].replace("$", ""));
    if (Number.isFinite(only)) return { price: null, salePrice: only };
  }

  return { price: null, salePrice: null };
}

function getProductContainers($) {
  // Primary
  let $products = $(".productTile__root");
  if ($products.length) return $products;

  // Fallback: product anchors ending in .html under /us/en-us/
  const anchors = $('a[href*=".html"]').filter((_, a) => {
    const href = ($(a).attr("href") || "").toLowerCase();
    if (!href) return false;
    if (!href.includes("/us/en-us/")) return false;
    if (!href.endsWith(".html")) return false;
    if (href.includes("customer-service") || href.includes("privacy") || href.includes("terms")) return false;
    return true;
  });

  const cardNodes = [];
  anchors.each((_, a) => {
    const $a = $(a);
    const $card = $a
      .closest('[class*="Tile"], [class*="tile"], [class*="Product"], [class*="product"], li, article, div')
      .first();
    if ($card && $card.length) cardNodes.push($card[0]);
  });

  const uniq = [];
  const seen = new Set();
  for (const n of cardNodes) {
    if (seen.has(n)) continue;
    seen.add(n);
    uniq.push(n);
  }

  return $(uniq);
}

function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];

  const normalizedUrl = String(sourceUrl || "").toLowerCase();
  let gender = "unisex";

  if (normalizedUrl.includes("aa20106000") || normalizedUrl.includes("womens-clearance")) {
    gender = "womens";
  } else if (
    normalizedUrl.includes("aa60101000") ||
    normalizedUrl.includes("aa10106000") ||
    normalizedUrl.includes("mens-clearance")
  ) {
    gender = "mens";
  } else if (normalizedUrl.includes("leaving-asics") || normalizedUrl.includes("aa60400001")) {
    gender = "unisex";
  }

  gender = normalizeGender(gender);

  console.log(`[ASICS] Processing URL: ${sourceUrl} -> Gender: ${gender}`);
  console.log(`[ASICS] HTML length: ${html ? html.length : 0}`);

  const $products = getProductContainers($);
  console.log(`[ASICS] Product containers found: ${$products.length}`);

  $products.each((_, el) => {
    const $product = $(el);

    const $link =
      $product.find('a[href*="/us/en-us/"][href$=".html"]').first().length
        ? $product.find('a[href*="/us/en-us/"][href$=".html"]').first()
        : $product.find('a[href$=".html"]').first().length
          ? $product.find('a[href$=".html"]').first()
          : $product.find('a[href*=".html"]').first();

    if (!$link || !$link.length) return;

    let url = absolutizeAsicsUrl($link.attr("href"));
    if (!url) return;

    const aria = $link.attr("aria-label");
    const titleFromText = $link.text();
    const titleFromHeading = $product.find("h1,h2,h3,[class*='name'],[class*='Name'],[data-testid*='name']").first().text();

    let cleanTitle = String(aria || titleFromHeading || titleFromText || "")
      .replace(/Next slide/gi, "")
      .replace(/Previous slide/gi, "")
      .replace(/\bSale\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    cleanTitle = cleanTitle
      .replace(/\bMen'?s\b/gi, "")
      .replace(/\bWomen'?s\b/gi, "")
      .replace(/\bUnisex\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    const { price, salePrice } = extractPricesFromTile($product, $);

    let image = null;

    const sourceSrcset =
      $product.find("picture source[srcset]").first().attr("srcset") ||
      $product.find("picture source[data-srcset]").first().attr("data-srcset") ||
      null;

    image = pickBestFromSrcset(sourceSrcset);

    if (!image) {
      const $img = $product.find("img").first();
      const imgSrcset =
        $img.attr("srcset") || $img.attr("data-srcset") || $img.attr("data-lazy-srcset") || null;
      image = pickBestFromSrcset(imgSrcset);
    }

    if (!image) {
      const $img = $product.find("img").first();
      image =
        $img.attr("src") ||
        $img.attr("data-src") ||
        $img.attr("data-lazy-src") ||
        $img.attr("data-original") ||
        null;
    }

    if (!image) {
      const noscriptHtml = $product.find("noscript").first().html();
      if (noscriptHtml) {
        const $$ = cheerio.load(noscriptHtml);
        image = $$("img").first().attr("src") || $$("img").first().attr("data-src") || null;
      }
    }

    image = absolutizeAsicsUrl(image);

    if (image && (image.startsWith("data:") || image.toLowerCase().includes("placeholder"))) image = null;
    if (image && image.includes("$variantthumbnail$")) image = image.replace("$variantthumbnail$", "$zoom$");

    if (!image && url) {
      const derived = buildAsicsImageFromProductUrl(url);
      if (derived) image = derived;
    }

    const model = cleanTitle.replace(/^ASICS\s+/i, "").trim();

    products.push({
      title: cleanTitle,
      brand: "ASICS",
      model,
      salePrice: salePrice != null ? salePrice : null,
      price: price != null ? price : null,
      store: "ASICS",
      url,
      image: image || null,
      gender,
      shoeType: detectShoeType(cleanTitle, model),
    });
  });

  return products;
}

async function scrapeAsicsUrl(app, baseUrl, description) {
  console.log(`[ASICS] Scraping ${description}...`);

  const url = baseUrl.includes("?") ? `${baseUrl}&sz=100` : `${baseUrl}?sz=100`;
  console.log(`[ASICS] Fetching: ${url}`);

  try {
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ["html", "rawHtml"],

      // IMPORTANT: don't drop ecommerce grids
      onlyMainContent: false, // default is true :contentReference[oaicite:5]{index=5}

      // IMPORTANT: avoid cached "empty"
      maxAge: 0, // fetch fresh :contentReference[oaicite:6]{index=6}

      // extra wait (in addition to smart wait)
      waitFor: 1500, // ms :contentReference[oaicite:7]{index=7}

      // IMPORTANT: wait for a product selector to exist before scraping :contentReference[oaicite:8]{index=8}
      actions: [
        // wait for either the original tile or at least one product link
        { type: "wait", selector: ".productTile__root" },
        { type: "wait", selector: 'a[href$=".html"]' },
      ],

      timeout: 90000,
    });

    const html = scrapeResult?.html || scrapeResult?.rawHtml || "";

    if (process.env.ASICS_DEBUG_HTML === "1") {
      const safeName = description.replace(/\W+/g, "-").toLowerCase();
      await put(`debug-asics-${safeName}.html`, html || "", {
        access: "public",
        addRandomSuffix: false,
      });
      console.log(`[ASICS] Debug HTML written: debug-asics-${safeName}.html`);
    }

    const products = extractAsicsProducts(html, baseUrl);

    const missingImages = products.filter((p) => !p.image).length;
    console.log(`[ASICS] ${description}: Found ${products.length} products (${missingImages} missing images)`);

    return { success: true, products, count: products.length, url };
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return { success: false, products: [], count: 0, error: error.message, url };
  }
}

async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

  console.log("[ASICS] Starting scrape of all sale pages (sequential)...");

  const pages = [
    {
      url: "https://www.asics.com/us/en-us/mens-clearance-shoes/c/aa60101000/running/",
      description: "Men's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/womens-clearance-shoes/c/aa20106000/running/",
      description: "Women's Clearance",
    },
    {
      url: "https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/?prefn1=c_productGender&prefv1=Women%7CMen",
      description: "Last Chance Styles",
    },
  ];

  const results = [];
  const allProducts = [];

  for (let i = 0; i < pages.length; i++) {
    const { url, description } = pages[i];
    console.log(`[ASICS] Starting page ${i + 1}/${pages.length}: ${description}`);

    const result = await scrapeAsicsUrl(app, url, description);

    results.push({
      page: description,
      success: result.success,
      count: result.count,
      error: result.error || null,
      url: result.url,
    });

    if (result.success) allProducts.push(...result.products);

    if (i < pages.length - 1) {
      console.log("[ASICS] Waiting 2 seconds before next page...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

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
  console.log(`[ASICS] Total unique products: ${uniqueProducts.length} (${missingImagesTotal} missing images)`);
  console.log(`[ASICS] Results per page:`, results);

  return { products: uniqueProducts, pageResults: results };
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Re-enable this before cron in prod
  // const cronSecret = process.env.CRON_SECRET;
  // if (cronSecret && req.headers["x-cron-secret"] !== cronSecret) {
  //   return res.status(401).json({ error: "Unauthorized" });
  // }

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
      debugNote:
        process.env.ASICS_DEBUG_HTML === "1"
          ? "ASICS_DEBUG_HTML=1 enabled (debug-asics-*.html blobs written)"
          : "Set ASICS_DEBUG_HTML=1 to write debug-asics-*.html blobs",
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
