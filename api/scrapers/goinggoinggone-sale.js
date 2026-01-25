// api/scrapers/goinggoinggone-sale.js
// Scrapes Going Going Gone men's and women's sale running shoes using Firecrawl
// Two pages to scrape (men's + women's)
// Matches 10-field schema used by ASICS/Brooks/Shoebacca scrapers

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Detect shoe type from title
 */
function detectShoeType(title) {
  const titleLower = (title || '').toLowerCase();

  // Trail indicators
  if (/\b(trail|mountain|venture|gel-venture)\b/i.test(titleLower)) {
    return 'trail';
  }

  // Track/spike indicators
  if (/\b(track|spike|racing|carbon|tempo|vaporfly|alphafly)\b/i.test(titleLower)) {
    return 'track';
  }

  // Road is default
  return 'road';
}

/**
 * Extract brand from title
 */
function extractBrand(title) {
  if (!title) return 'Unknown';

  const commonBrands = [
    'Nike', 'Adidas', 'ASICS', 'Brooks', 'New Balance', 
    'Hoka', 'HOKA', 'Saucony', 'Mizuno', 'On', 'Altra',
    'Salomon', 'Reebok', 'Under Armour', 'Puma', 'Skechers',
    'Topo Athletic', 'Karhu', 'Diadora', 'Newton', 'Saysh'
  ];

  for (const brand of commonBrands) {
    if (title.toLowerCase().includes(brand.toLowerCase())) {
      return brand;
    }
  }

  // Try to extract first word as brand
  const firstWord = title.trim().split(/\s+/)[0];
  if (firstWord && firstWord.length > 2) {
    return firstWord;
  }

  return 'Unknown';
}

/**
 * Extract model name from title (remove brand and gender)
 */
function extractModel(title, brand) {
  if (!title) return '';

  let model = title;

  // Remove brand name from start
  if (brand && brand !== 'Unknown') {
    const brandRegex = new RegExp(`^${brand}\\s+`, 'i');
    model = model.replace(brandRegex, '');
  }

  // Remove "Women's" or "Men's" prefix
  model = model
    .replace(/^women's\s+/i, '')
    .replace(/^men's\s+/i, '')
    .replace(/\s+running\s+shoe(s)?$/i, '')
    .replace(/\s+road\s+running\s+shoe(s)?$/i, '')
    .trim();

  return model;
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  
  const cleaned = String(priceStr)
    .replace(/[^0-9.]/g, '')
    .trim();
  
  const num = parseFloat(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Extract products from Going Going Gone HTML
 */
function extractGoingGoingGoneProducts(html, gender) {
  const $ = cheerio.load(html);
  const products = [];

  console.log(`[Going Going Gone] Parsing HTML for ${gender}...`);

  // Find all product links
  const $productLinks = $('a[href*="/p/"]');
  
  console.log(`[Going Going Gone] Found ${$productLinks.length} product links`);

  const seenUrls = new Set();

  $productLinks.each((i, el) => {
    const $link = $(el);
    
    // Get URL
    let url = $link.attr('href') || '';
    if (!url || url === '#') return;
    
    // Make URL absolute
    if (!url.startsWith('http')) {
      url = `https://www.goinggoinggone.com${url}`;
    }

    // Skip duplicates
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    // Find the product container (parent elements)
    const $product = $link.closest('div, article, li');

    // Get title from link text or aria-label
    const title = 
      $link.attr('aria-label') ||
      $link.attr('title') ||
      $link.text().trim() ||
      '';

    if (!title || title.length < 3) return;

    // Get image
    let image = 
      $link.find('img').first().attr('src') ||
      $link.find('img').first().attr('data-src') ||
      $product.find('img').first().attr('src') ||
      null;

    // Make image URL absolute
    if (image && !image.startsWith('http')) {
      if (image.startsWith('//')) {
        image = `https:${image}`;
      } else if (image.startsWith('/')) {
        image = `https://www.goinggoinggone.com${image}`;
      }
    }

    // Skip placeholder images
    if (image && (image.includes('placeholder') || image.startsWith('data:'))) {
      image = null;
    }

    // Get prices from the product container or nearby text
    const priceContainer = $product.text();
    const priceMatches = priceContainer.match(/\$(\d+(?:\.\d{2})?)/g);

    let salePrice = null;
    let price = null;

    if (priceMatches && priceMatches.length >= 2) {
      // Multiple prices found - assume first is sale, second is original
      salePrice = parsePrice(priceMatches[0]);
      price = parsePrice(priceMatches[1]);
    } else if (priceMatches && priceMatches.length === 1) {
      // Only one price - treat as sale price
      salePrice = parsePrice(priceMatches[0]);
    }

    // Ensure sale price is lower than original
    if (salePrice && price && salePrice > price) {
      [salePrice, price] = [price, salePrice];
    }

    if (!salePrice) return;

    // Extract brand and model
    const brand = extractBrand(title);
    const model = extractModel(title, brand);

    // Detect shoe type
    const shoeType = detectShoeType(title);

    products.push({
      title: title.trim(),
      brand,
      model,
      salePrice,
      price,
      store: 'Going Going Gone',
      url,
      image,
      gender,
      shoeType,
    });
  });

  console.log(`[Going Going Gone] Extracted ${products.length} products for ${gender}`);
  return products;
}

/**
 * Scrape a single Going Going Gone page
 */
async function scrapeGoingGoingGonePage(app, url, gender) {
  console.log(`[Going Going Gone] Scraping ${gender} page...`);

  try {
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html'],
      waitFor: 5000, // Wait 5 seconds
      timeout: 45000,
    });

    const products = extractGoingGoingGoneProducts(scrapeResult.html, gender);

    console.log(`[Going Going Gone] ${gender}: Found ${products.length} products`);

    return {
      success: true,
      products,
      count: products.length,
    };
  } catch (error) {
    console.error(`[Going Going Gone] Error scraping ${gender}:`, error.message);
    return {
      success: false,
      products: [],
      count: 0,
      error: error.message,
    };
  }
}

/**
 * Scrape both men's and women's pages
 */
async function scrapeGoingGoingGoneSale() {
  const app = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY,
  });

  console.log('[Going Going Gone] Starting scrape of both pages...');

  const pages = [
    {
      url: 'https://www.goinggoinggone.com/f/shop-all-womens-sale?pageSize=96&filterFacets=4285%253ARunning%253B5382%253AAthletic%2520%2526%2520Sneakers',
      gender: 'womens',
    },
    {
      url: 'https://www.goinggoinggone.com/f/shop-all-mens-sale?pageSize=96&filterFacets=4285%253ARunning%253B5382%253AAthletic%2520%2526%2520Sneakers',
      gender: 'mens',
    },
  ];

  const allProducts = [];

  // Scrape both pages sequentially
  for (const { url, gender } of pages) {
    const result = await scrapeGoingGoingGonePage(app, url, gender);
    
    if (result.success) {
      allProducts.push(...result.products);
    }

    // Add delay between requests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Deduplicate by URL
  const uniqueProducts = [];
  const seenUrls = new Set();

  for (const product of allProducts) {
    if (!seenUrls.has(product.url)) {
      seenUrls.add(product.url);
      uniqueProducts.push(product);
    }
  }

  const missingImages = uniqueProducts.filter(p => !p.image).length;
  const missingPrices = uniqueProducts.filter(p => !p.price).length;

  console.log(`[Going Going Gone] Total unique products: ${uniqueProducts.length}`);
  console.log(`[Going Going Gone] Missing images: ${missingImages}`);
  console.log(`[Going Going Gone] Missing original prices: ${missingPrices}`);

  return {
    success: true,
    products: uniqueProducts,
  };
}

/**
 * Vercel handler
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.headers['x-cron-secret'] || 
                         req.headers.authorization?.replace('Bearer ', '');
  
  if (cronSecret && providedSecret !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const start = Date.now();

  try {
    const { products: deals, success } = await scrapeGoingGoingGoneSale();

    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Scraping failed',
        duration: `${Date.now() - start}ms`,
      });
    }

    // Calculate stats
    const byGender = {
      mens: deals.filter(d => d.gender === 'mens').length,
      womens: deals.filter(d => d.gender === 'womens').length,
      unisex: deals.filter(d => d.gender === 'unisex').length,
    };

    const byShoeType = {
      road: deals.filter(d => d.shoeType === 'road').length,
      trail: deals.filter(d => d.shoeType === 'trail').length,
      track: deals.filter(d => d.shoeType === 'track').length,
    };

    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Going Going Gone',
      segments: ["Women's Sale", "Men's Sale"],
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      deals,
    };

    // Save to Vercel Blob
    const blob = await put('goinggoinggone-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false,
    });

    const duration = Date.now() - start;

    console.log(`[Going Going Gone] ✓ Complete! ${deals.length} deals in ${duration}ms`);
    console.log(`[Going Going Gone] Blob URL: ${blob.url}`);

    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: byGender,
      dealsByShoeType: byShoeType,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated,
    });
  } catch (error) {
    console.error('[Going Going Gone] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`,
    });
  }
};
