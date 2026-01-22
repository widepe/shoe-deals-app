// api/scrapers/asics-sale-debug.js
// Debug version to inspect ASICS HTML structure

const FirecrawlApp = require('@mendable/firecrawl-js').default;
const cheerio = require('cheerio');

async function debugAsicsPage(url, description) {
  const app = new FirecrawlApp({ 
    apiKey: process.env.FIRECRAWL_API_KEY 
  });
  
  console.log(`[DEBUG] Fetching ${description}...`);
  
  const scrapeResult = await app.scrapeUrl(url, {
    formats: ['html', 'markdown'],
    waitFor: 5000,
    timeout: 30000
  });
  
  const $ = cheerio.load(scrapeResult.html);
  
  // Test various selectors
  const selectorTests = {
    'product-tile': $('.product-tile').length,
    'product-item': $('.product-item').length,
    'product': $('.product').length,
    '[class*="product"]': $('[class*="product"]').length,
    'a[href*="/p/"]': $('a[href*="/p/"]').length,
    'img.product-image': $('img.product-image').length,
    'Any img': $('img').length,
    'Any links': $('a').length,
    '.price': $('.price').length,
    '[class*="price"]': $('[class*="price"]').length,
  };
  
  // Get a sample of what we find
  const sampleHtml = [];
  
  // Try to find product-like elements
  $('[class*="product"]').slice(0, 3).each((i, el) => {
    const $el = $(el);
    sampleHtml.push({
      classes: $el.attr('class'),
      text: $el.text().substring(0, 200),
      hasLinks: $el.find('a').length,
      hasImages: $el.find('img').length,
      hasPrices: $el.find('[class*="price"]').length
    });
  });
  
  // Check if product names are in the markdown
  const hasGelNimbus = scrapeResult.markdown.includes('GEL-NIMBUS');
  const hasGelVenture = scrapeResult.markdown.includes('GEL-VENTURE');
  const hasPrice = scrapeResult.markdown.includes('$');
  
  return {
    description,
    url,
    selectorTests,
    sampleHtml,
    markdownCheck: {
      hasGelNimbus,
      hasGelVenture,
      hasPrice
    },
    markdownPreview: scrapeResult.markdown.substring(0, 2000)
  };
}

module.exports = async (req, res) => {
  try {
    // Just debug the men's page for now
    const result = await debugAsicsPage(
      'https://www.asics.com/us/en-us/mens-clearance/c/aa10106000/running/shoes/',
      "Men's Clearance"
    );
    
    return res.status(200).json({
      success: true,
      debug: result
    });
    
  } catch (error) {
    console.error('[DEBUG] Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
