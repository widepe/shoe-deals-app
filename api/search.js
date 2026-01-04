const https = require('https');
const http = require('http');

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

// Simple HTTP GET request helper
function fetch(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'ShoeBeagle/1.0 (Price Comparison Bot)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// Simple HTML parser - extracts text between tags
function extractText(html, startTag, endTag) {
  const results = [];
  let pos = 0;
  while (true) {
    const start = html.indexOf(startTag, pos);
    if (start === -1) break;
    const end = html.indexOf(endTag, start + startTag.length);
    if (end === -1) break;
    results.push(html.substring(start + startTag.length, end).trim());
    pos = end + endTag.length;
  }
  return results;
}

// Scrape Running Warehouse (they allow price comparison bots)
async function scrapeRunningWarehouse(brand, model) {
  try {
    const searchQuery = `${brand} ${model}`.replace(/\s+/g, '+');
    const url = `https://www.runningwarehouse.com/searchresults.html?search=${searchQuery}&opt_page=1&opt_perpage=10`;
    
    console.log('[Running Warehouse] Fetching:', url);
    const response = await fetch(url);
    
    if (response.status !== 200) {
      console.log('[Running Warehouse] Bad status:', response.status);
      return [];
    }

    const html = response.body;
    const results = [];

    // Extract product blocks - Running Warehouse uses specific div structure
    const productBlocks = html.split('class="product');
    
    for (let i = 1; i < Math.min(productBlocks.length, 6); i++) {
      const block = productBlocks[i];
      
      // Extract title
      const titleMatch = block.match(/title="([^"]+)"/);
      const title = titleMatch ? titleMatch[1] : null;
      
      // Extract price
      const priceMatch = block.match(/\$(\d+\.?\d*)/);
      const price = priceMatch ? parseFloat(priceMatch[1]) : null;
      
      // Extract URL
      const urlMatch = block.match(/href="([^"]+)"/);
      const productUrl = urlMatch ? `https://www.runningwarehouse.com${urlMatch[1]}` : null;
      
      // Extract image
      const imgMatch = block.match(/src="([^"]+\.jpg[^"]*)"/);
      const image = imgMatch ? imgMatch[1] : null;

      if (title && price && productUrl) {
        // Filter: only include if it matches brand/model
        const normalizedTitle = normalize(title);
        const normalizedBrand = normalize(brand);
        const normalizedModel = normalize(model);
        
        if (normalizedTitle.includes(normalizedBrand) || normalizedTitle.includes(normalizedModel)) {
          results.push({
            title: title,
            price: price,
            store: 'Running Warehouse',
            url: productUrl,
            image: image || 'https://placehold.co/600x400?text=Running+Shoe'
          });
        }
      }
    }

    console.log('[Running Warehouse] Found:', results.length, 'results');
    return results;
  } catch (err) {
    console.error('[Running Warehouse] Error:', err.message);
    return [];
  }
}

// Scrape Road Runner Sports (public product pages allowed)
async function scrapeRoadRunnerSports(brand, model) {
  try {
    const searchQuery = `${brand} ${model}`.replace(/\s+/g, '+');
    const url = `https://www.roadrunnersports.com/search?q=${searchQuery}`;
    
    console.log('[Road Runner Sports] Fetching:', url);
    const response = await fetch(url);
    
    if (response.status !== 200) {
      console.log('[Road Runner Sports] Bad status:', response.status);
      return [];
    }

    const html = response.body;
    const results = [];

    // Extract product data
    const productBlocks = html.split('data-product-tile');
    
    for (let i = 1; i < Math.min(productBlocks.length, 6); i++) {
      const block = productBlocks[i];
      
      const titleMatch = block.match(/data-product-name="([^"]+)"/);
      const title = titleMatch ? titleMatch[1] : null;
      
      const priceMatch = block.match(/data-product-price="([^"]+)"/);
      const price = priceMatch ? parseFloat(priceMatch[1]) : null;
      
      const urlMatch = block.match(/href="([^"]+)"/);
      const productUrl = urlMatch ? `https://www.roadrunnersports.com${urlMatch[1]}` : null;
      
      const imgMatch = block.match(/data-src="([^"]+\.jpg[^"]*)"/);
      const image = imgMatch ? imgMatch[1] : null;

      if (title && price && productUrl) {
        const normalizedTitle = normalize(title);
        const normalizedBrand = normalize(brand);
        const normalizedModel = normalize(model);
        
        if (normalizedTitle.includes(normalizedBrand) || normalizedTitle.includes(normalizedModel)) {
          results.push({
            title: title,
            price: price,
            store: 'Road Runner Sports',
            url: productUrl,
            image: image || 'https://placehold.co/600x400?text=Running+Shoe'
          });
        }
      }
    }

    console.log('[Road Runner Sports] Found:', results.length, 'results');
    return results;
  } catch (err) {
    console.error('[Road Runner Sports] Error:', err.message);
    return [];
  }
}

// In-memory cache (4 hour TTL)
const cache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

module.exports = async (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;
  const startedAt = Date.now();

  try {
    const rawQuery = req.query && req.query.query ? req.query.query : "";
    const query = normalize(rawQuery);
    
    console.log("[/api/search] start", { requestId, query });

    if (!query) {
      res.status(400).json({
        error: "Missing query parameter",
        example: "/api/search?query=Nike%20Pegasus",
        requestId
      });
      return;
    }

    // Check cache first
    const cacheKey = `search:${query}`;
    const cached = getCached(cacheKey);
    if (cached) {
      console.log("[/api/search] cache hit", { requestId, count: cached.length });
      res.status(200).json({ results: cached, requestId, cached: true });
      return;
    }

    // Parse brand and model from query
    const parts = rawQuery.trim().split(/\s+/);
    const brand = parts[0] || "";
    const model = parts.slice(1).join(" ") || "";

    console.log("[/api/search] Parsed:", { brand, model });

    // Scrape multiple sources in parallel (with delay between them to be polite)
    const allResults = [];
    
    // Running Warehouse
    const rwResults = await scrapeRunningWarehouse(brand, model);
    allResults.push(...rwResults);
    
    // Wait 2 seconds to be polite
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Road Runner Sports
    const rrsResults = await scrapeRoadRunnerSports(brand, model);
    allResults.push(...rrsResults);

    // Deduplicate by URL and sort by price
    const seen = new Set();
    const results = allResults
      .filter(item => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      })
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, 12);

    // Cache results
    setCache(cacheKey, results);

    console.log("[/api/search] done (200)", {
      requestId,
      ms: Date.now() - startedAt,
      count: results.length
    });

    res.status(200).json({ results, requestId });

  } catch (err) {
    console.error("[/api/search] error", {
      requestId,
      message: err?.message || String(err),
      stack: err?.stack
    });
    res.status(500).json({ error: "Internal server error", requestId });
  }
};
