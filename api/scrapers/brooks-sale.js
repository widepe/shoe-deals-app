// api/scrapers/brooks-sale.js
// FINAL FIX - Uses data attributes which actually contain the product info

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');
const { put } = require('@vercel/blob');

function extractBrooksProducts(html) {
  const $ = cheerio.load(html);
  const products = [];
  
  // Brooks uses: o-products-grid__item for product containers
  $('.o-products-grid__item').each((i, el) => {
    const $product = $(el);
    const $content = $product.find('.o-products-grid__item-content');
    
    // Get title from data attribute!
    const title = $content.attr('data-cnstrc-item-name');
    const productId = $content.attr('data-pid');
    
    if (!title) return; // Skip if no title
    
    // Get prices from the actual price display elements
    const $priceContainer = $product.find('.m-product-tile__price-container, [class*="price"]');
    const priceText = $priceContainer.find('.price-sales, .sales, [class*="sales"]').text().trim();
    const originalPriceText = $priceContainer.find('.price-list, [class*="price-list"]').text().trim();
    
    // Parse prices
    let price = null;
    let originalPrice = null;
    
    if (priceText) {
      const priceMatch = priceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
      if (priceMatch) price = parseFloat(priceMatch[1]);
    }
    
    if (originalPriceText) {
      const origMatch = originalPriceText.match(/\$?\s*(\d+(?:\.\d{2})?)/);
      if (origMatch) originalPrice = parseFloat(origMatch[1]);
    }
    
    // Get URL - look for the main product link
    let url = $product.find('a.m-product-tile__link, a[href*="/products/"]').first().attr('href');
    
    // Get image
    const image = (
      $product.find('img.m-product-tile__image').first().attr('src') ||
      $product.find('img').first().attr('src') ||
      $product.find('img').first().attr('data-src')
    );
    
    // Calculate discount percentage
    const discount = originalPrice && price && originalPrice > price ?
      Math.round(((originalPrice - price) / originalPrice) * 100) : null;
    
    // Extract model from title (remove "Brooks" if present)
    const model = title.replace(/^Brooks\s+/i, '').trim();
    
    products.push({
      title,
      brand: 'Brooks',
      model,
      store: 'Brooks Running',
      price,
      originalPrice,
      discount: discount ? `${discount}%` : null,
      url: url ? (url.startsWith('http') ? url : `https://www.brooksrunning.com${url}`) : null,
      image: image ? (image.startsWith('http') ? image : `https://www.brooksrunning.com${image}`) : null,
      productId: productId,
      scrapedAt: new Date().toISOString()
    });
  });
  
  return products;
}

async function scrapeBrooksSale() {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  console.log('Starting Brooks scrape with Firecrawl...');
  
  const scrapeResult = await app.scrapeUrl(
    'https://www.brooksrunning.com/en_us/sale/?prefn1=productType&prefv1=Shoes',
    {
      formats: ['html'],
      waitFor: 5000,
      timeout: 30000
    }
  );
  
  console.log('Firecrawl scrape complete, parsing HTML...');
  const products = extractBrooksProducts(scrapeResult.html);
  console.log(`Found ${products.length} products`);
  
  return products;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers['x-cron-secret'] !== cronSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const start = Date.now();
  
  try {
    const deals = await scrapeBrooksSale();
    
    const output = {
      lastUpdated: new Date().toISOString(),
      store: 'Brooks Running',
      segment: 'sale-shoes',
      totalDeals: deals.length,
      deals: deals
    };
    
    const blob = await put('brooks-sale.json', JSON.stringify(output, null, 2), {
      access: 'public',
      addRandomSuffix: false
    });
    
    return res.status(200).json({
      success: true,
      totalDeals: deals.length,
      blobUrl: blob.url,
      duration: `${Date.now() - start}ms`,
      timestamp: output.lastUpdated
    });
    
  } catch (error) {
    console.error('Error in Brooks scraper:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      duration: `${Date.now() - start}ms`
    });
  }
};
