// api/scrapers/asics-sale.js
// Scrapes all three ASICS sale pages using Firecrawl:
// 1. Men's clearance running shoes
// 2. Women's clearance running shoes  
// 3. Last chance styles (running shoes - Men & Women)

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

/**
 * Extract products from ASICS HTML
 * Uses flexible selectors to handle different page structures
 */
function extractAsicsProducts(html, sourceUrl) {
  const $ = cheerio.load(html);
  const products = [];
  
  // Determine gender from URL for categorization
  let gender = 'Unisex';
  if (sourceUrl.includes('mens-clearance')) {
    gender = 'Men';
  } else if (sourceUrl.includes('womens-clearance')) {
    gender = 'Women';
  } else if (sourceUrl.includes('leaving-asics')) {
    gender = 'Unisex'; // Last chance has both
  }
  
  // Look for product tiles/cards with multiple possible selectors
  const possibleSelectors = [
    '.product-tile',
    '.product-item',
    '.product-grid-item',
    '.product',
    '[class*="product-tile"]',
    '[class*="product-item"]',
    '[data-product]'
  ];
  
  let $products = $();
  for (const selector of possibleSelectors) {
    $products = $(selector);
    if ($products.length > 0) {
      console.log(`Found ${$products.length} products using selector: ${selector}`);
      break;
    }
  }
  
  $products.each((i, el) => {
    const $product = $(el);
    
    // Extract title - try multiple methods
    let title = (
      $product.find('.product-name').first().text().trim() ||
      $product.find('.product-title').first().text().trim() ||
      $product.find('[class*="product-name"]').first().text().trim() ||
      $product.find('[class*="title"]').first().text().trim() ||
      $product.find('h2, h3, h4').first().text().trim() ||
      $product.find('a').first().attr('title') ||
      $product.find('a').first().attr('aria-label') ||
      $product.find('img').first().attr('alt') ||
      ''
    );
    
    // Clean up title
    title = title.replace(/\s+/g, ' ').trim();
    
    if (!title || title.length < 3) return; // Skip if no valid title
    
    // Extract prices with multiple fallback methods
    let price = null;
    let originalPrice = null;
    
    // Method 1: Look for specific price classes
    const $salePrice = $product.find('.price-sales, .sale-price, [class*="sale-price"], [class*="current-price"]').first();
    const $originalPrice = $product.find('.price-list, .original-price, .price-standard, [class*="original"], [class*="list-price"]').first();
    const $strikePrice = $product.find('.price-strike, .strikethrough, [class*="strike"], s, del').first();
    
    // Try to get sale price
    if ($salePrice.length > 0) {
      const salePriceText = $salePrice.text().trim();
      const priceMatch = salePriceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
      if (priceMatch) price = parseFloat(priceMatch[1]);
    }
    
    // Try to get original price
    if ($originalPrice.length > 0) {
      const origPriceText = $originalPrice.text().trim();
      const origMatch = origPriceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
      if (origMatch) originalPrice = parseFloat(origMatch[1]);
    } else if ($strikePrice.length > 0) {
      const strikePriceText = $strikePrice.text().trim();
      const strikeMatch = strikePriceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
      if (strikeMatch) originalPrice = parseFloat(strikeMatch[1]);
    }
    
    // Method 2: If we didn't find prices, look for any price-related elements
    if (!price || !originalPrice) {
      const $allPrices = $product.find('[class*="price"]');
      const priceTexts = [];
      
      $allPrices.each((j, priceEl) => {
        const priceText = $(priceEl).text().trim();
        const match = priceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
        if (match) {
          priceTexts.push(parseFloat(match[1]));
        }
      });
      
      // If we have multiple prices, assume lowest is sale price, highest is original
      if (priceTexts.length >= 2) {
        const sorted = priceTexts.sort((a, b) => a - b);
        if (!price) price = sorted[0];
        if (!originalPrice) originalPrice = sorted[sorted.length - 1];
      } else if (priceTexts.length === 1 && !price) {
        price = priceTexts[0];
      }
    }
    
    // Get URL - try multiple methods
    let url = (
      $product.find('a.product-tile__link').first().attr('href') ||
      $product.find('a[href*="/p/"]').first().attr('href') ||
      $product.find('a[href*="product"]').first().attr('href') ||
      $product.find('a').first().attr('href') ||
      $product.attr('data-href')
    );
    
    // Make URL absolute
    if (url && !url.startsWith('http')) {
      url = url.startsWith('/') ? `https://www.asics.com${url}` : `https://www.asics.com/${url}`;
    }
    
    // Get image - try multiple methods
    const image = (
      $product.find('img.product-image').first().attr('src') ||
      $product.find('img.tile-image').first().attr('src') ||
      $product.find('.product-tile img').first().attr('src') ||
      $product.find('img[class*="product"]').first().attr('src') ||
      $product.find('img').first().attr('src') ||
      $product.find('img').first().attr('data-src') ||
      $product.find('img').first().attr('data-lazy-src')
    );
    
    // Make image URL absolute
    let imageUrl = null;
    if (image) {
      imageUrl = image.startsWith('http') ? image : 
                 image.startsWith('//') ? `https:${image}` :
                 image.startsWith('/') ? `https://www.asics.com${image}` :
                 `https://www.asics.com/${image}`;
    }
    
    // Calculate discount percentage
    const discount = originalPrice && price && originalPrice > price ?
      Math.round(((originalPrice - price) / originalPrice) * 100) : null;
    
    // Extract model from title (remove "ASICS" prefix if present)
    const model = title.replace(/^ASICS\s+/i, '').trim();
    
    // Only add product if we have essential data
    if (title && (price || originalPrice)) {
      products.push({
        title,
        brand: 'ASICS',
        model,
        store: 'ASICS',
        gender,
        price,
        originalPrice,
        discount: discount ? `${discount}%` : null,
        url: url || null,
        image: imageUrl,
        scrapedAt: new Date().toISOString()
      });
    }
  });
  
  return products;
}

/**
 * Scrape a single ASICS URL using Firecrawl
 */
async function scrapeAsicsUrl(app, url, description) {
  console.log(`[ASICS] Scraping ${description}...`);
  
  try {
    const scrapeResult = await app.scrapeUrl(url, {
      formats: ['html'],
      waitFor: 5000,
      timeout: 30000
    });
    
    const products = extractAsicsProducts(scrapeResult.html, url);
    console.log(`[ASICS] ${description}: Found ${products.length} products`);
    
    return products;
  } catch (error) {
    console.error(`[ASICS] Error scraping ${description}:`, error.message);
    return [];
  }
}

/**
 * Main scraper function - scrapes all three ASICS sale pages
 */
async function scrapeAllAsicsSales() {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  console.log('[ASICS] Starting scrape of all sale pages with Firecrawl...');
  
  // Define all URLs to scrape
  const urls = [
    {
      url: 'https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/',
      description: "Men's Clearance"
    },
    {
      url: 'https://www.asics.com/us/en-us/womens-clearance/c/aa20106000/running/shoes/',
      description: "Women's Clearance"
    },
    {
      url: 'https://www.asics.com/us/en-us/styles-leaving-asics-com/c/aa60400001/running/shoes/?prefn1=c_productGender&prefv1=Women%7CMen',
      description: "Last Chance Styles"
    }
  ];
  
  // Scrape all URLs in parallel for faster execution
  const results = await Promise.allSettled(
    urls.map(({ url, description }) => scrapeAsicsUrl(app, url, description))
  );
  
  // Combine all products
  const allProducts = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      allProducts.push(...result.value);
    } else {
      console.error(`[ASICS] Failed to scrape ${urls[index].description}:`, result.reason);
    }
  });
  
  // Deduplicate products based on URL (in case same product appears in multiple pages)
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
  
  console.log(`[ASICS] Total unique products found: ${uniqueProducts.length}`);
  
  return uniqueProducts;
}

/**
 * Vercel serverless function handler
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Optional: Protect endpoint with secret (for cron jobs)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const start = Date.now();
  
  try {
    const deals = await scrapeAllAsicsSales();
    
    // Create output object
    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'ASICS',
      segments: [
        "Men's Clearance",
        "Women's Clearance", 
        "Last Chance Styles"
      ],
      totalDeals: deals.length,
      dealsByGender: {
        Men: deals.filter(d => d.gender === 'Men').length,
        Women: deals.filter(d => d.gender === 'Women').length,
        Unisex: deals.filter(d => d.gender === 'Unisex').length
      },
      deals: deals
    };
    
    // Save to blob storage
    const blob = await put('asics-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
    });
    
    const duration = Date.now() - start;
    
    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      dealsByGender: output.dealsByGender,
      blobUrl: blob.url,
      duration: `${duration}ms`,
      timestamp: output.lastUpdated
    });
    
  } catch (error) {
    console.error('[ASICS] Fatal error:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`
    });
  }
};
