// /api/cron/check-alerts.js
const { list } = require("@vercel/blob");
const sgMail = require("@sendgrid/mail");

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Matching logic from search.js
function normalizeStr(s) {
  return String(s || "").trim().toLowerCase();
}

function tokenize(s) {
  return normalizeStr(s)
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function squash(s) {
  return normalizeStr(s).replace(/\s+/g, "");
}

function dealMatchesAlert(deal, alert) {
  const dealBrandTokens = tokenize(deal.brand || "");
  const dealModelTokens = tokenize(deal.model || "");
  const dealSquashed = squash(`${deal.brand} ${deal.model}`);

  const alertBrandTokens = tokenize(alert.brand || "");
  const alertModelTokens = tokenize(alert.model || "");
  const alertSquashed = squash(`${alert.brand} ${alert.model}`);

  // Brand matching
  let brandMatches = false;
  if (alertBrandTokens.length > 0) {
    brandMatches = alertBrandTokens.some(token => 
      dealBrandTokens.some(dt => dt.startsWith(token) || token.startsWith(dt))
    );
  } else {
    brandMatches = true;
  }

  // Model matching
  let modelMatches = false;
  if (alertModelTokens.length > 0) {
    modelMatches = alertModelTokens.some(token =>
      dealModelTokens.some(dt => dt.startsWith(token) || token.startsWith(dt))
    );
    
    // Squashed matching for "gt2000" vs "GT-2000"
    if (!modelMatches && alertSquashed.length >= 4 && dealSquashed.length >= 4) {
      modelMatches = dealSquashed.includes(alertSquashed) || alertSquashed.includes(dealSquashed);
    }
  } else {
    modelMatches = true;
  }

  // Price matching
  const dealPrice = Number(deal.salePrice ?? deal.price);
  const alertPrice = Number(alert.targetPrice);
  const priceMatches = dealPrice <= alertPrice;

  return brandMatches && modelMatches && priceMatches;
}

function generateMatchEmail(alert, matches, daysLeft) {
  // Sort by price (lowest first)
  const sorted = matches.sort((a, b) => {
    const priceA = Number(a.salePrice ?? a.price);
    const priceB = Number(b.salePrice ?? b.price);
    return priceA - priceB;
  });

  // Take top 12
  const topDeals = sorted.slice(0, 12);

  const dealsHtml = topDeals.map(deal => {
    const price = Number(deal.salePrice ?? deal.price).toFixed(2);
    const originalPrice = deal.price && deal.salePrice && Number(deal.price) > Number(deal.salePrice)
      ? `<span style="text-decoration: line-through; color: #999; margin-left: 8px;">$${Number(deal.price).toFixed(2)}</span>`
      : "";
    
    return `
    <div style="border: 1px solid #ddd; border-radius: 8px; padding: 15px; margin-bottom: 15px; background: #f9f9f9;">
      ${deal.image ? `<img src="${deal.image}" alt="${deal.brand} ${deal.model}" style="max-width: 150px; height: auto; border-radius: 4px; margin-bottom: 10px;">` : ""}
      <h3 style="margin: 0 0 10px; color: #214478; font-size: 16px;">${deal.brand} ${deal.model}</h3>
      <p style="margin: 5px 0; font-size: 14px;"><strong>Store:</strong> ${deal.store}</p>
      <p style="margin: 5px 0; font-size: 14px;">
        <strong>Price:</strong> 
        <span style="color: #dc3545; font-size: 18px; font-weight: bold;">$${price}</span> 
        ${originalPrice}
      </p>
      <a href="${deal.url}" style="display: inline-block; margin-top: 10px; padding: 10px 20px; background: #214478; color: white; text-decoration: none; border-radius: 5px; font-size: 14px;">View Deal</a>
    </div>
    `;
  }).join('');

  const searchQuery = encodeURIComponent(`${alert.brand} ${alert.model}`);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4ede3;">
  <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: white; border-radius: 10px; padding: 30px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
      <div style="text-align: center; margin-bottom: 30px;">
        <img src="https://shoebeagle.com/images/logo.png" alt="Shoe Beagle" style="max-width: 300px; height: auto;">
      </div>
      
      <h1 style="color: #214478; margin: 0 0 20px; font-size: 24px;">🎉 Great News! We Found Your Shoes!</h1>
      
      <p style="font-size: 16px; line-height: 1.6; color: #333; margin-bottom: 20px;">
        We found <strong>${matches.length}</strong> deal${matches.length > 1 ? 's' : ''} for 
        <strong>${alert.brand} ${alert.model}</strong> at or below your target price of 
        <strong>$${Math.round(alert.targetPrice)}</strong>!
      </p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="https://shoebeagle.com/?query=${searchQuery}" 
           style="display: inline-block; padding: 15px 40px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px;">
          Click Here to View Your Deals
        </a>
      </div>

      <p style="font-size: 14px; color: #666; text-align: center; margin-bottom: 30px;">
        The search will automatically show you all ${matches.length} deals sorted by lowest price first
      </p>

      <h2 style="color: #214478; font-size: 18px; margin-top: 30px; margin-bottom: 15px;">
        Top ${Math.min(12, topDeals.length)} Deals (Lowest Price First):
      </h2>

      ${dealsHtml}

      <div style="margin-top: 30px; padding: 20px; background: #f4ede3; border-radius: 8px;">
        <p style="margin: 0; font-size: 14px; color: #333; line-height: 1.6;">
          <strong>Your alert will continue checking daily ${daysLeft > 0 ? `for the next ${daysLeft} days` : 'until the end of today'}</strong> 
          (or until you cancel it). If we find more matches, we'll send you another update!
        </p>
      </div>

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd;">
        <p style="font-size: 14px; color: #666; margin-bottom: 15px;">
          Want to manage or cancel this alert?
        </p>
        <a href="https://shoebeagle.com/pages/myalerts.html?email=${encodeURIComponent(alert.email)}" 
           style="display: inline-block; padding: 10px 25px; background: #214478; color: white; text-decoration: none; border-radius: 5px; font-size: 14px;">
          Manage My Alerts
        </a>
      </div>

      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
        <p style="margin: 5px 0;">
          Shoe Beagle does not sell products directly and is not responsible for changes in price, 
          availability, or shipping terms on retailer sites.
        </p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

module.exports = async (req, res) => {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log("[CRON] Unauthorized request");
    return res.status(401).json({ error: "Unauthorized" });
  }

  console.log("[CRON] Starting alert check...", new Date().toISOString());
  const startTime = Date.now();

  try {
    // Load deals.json
    console.log("[CRON] Loading deals...");
    const { blobs: dealBlobs } = await list({ prefix: "deals.json" });
    
    if (!dealBlobs || dealBlobs.length === 0) {
      throw new Error("Could not locate deals.json");
    }

    const dealsResponse = await fetch(dealBlobs[0].url);
    const dealsData = await dealsResponse.json();
    const deals = Array.isArray(dealsData.deals) ? dealsData.deals : [];
    
    console.log(`[CRON] Loaded ${deals.length} deals`);

    // Load alerts.json
    console.log("[CRON] Loading alerts...");
    const { blobs: alertBlobs } = await list({ prefix: "alerts.json" });
    
    if (!alertBlobs || alertBlobs.length === 0) {
      console.log("[CRON] No alerts file found");
      return res.status(200).json({ 
        success: true, 
        message: "No alerts to check",
        alertsChecked: 0,
        emailsSent: 0
      });
    }

    const alertsResponse = await fetch(alertBlobs[0].url);
    const alertsData = await alertsResponse.json();
    let alerts = Array.isArray(alertsData.alerts) ? alertsData.alerts : [];

    // Filter to active alerts only
    const now = Date.now();
    const activeAlerts = alerts.filter(a => 
      !a.cancelledAt && 
      (a.setAt + 30 * 24 * 60 * 60 * 1000) > now
    );

    console.log(`[CRON] Found ${activeAlerts.length} active alerts`);

    if (activeAlerts.length === 0) {
      return res.status(200).json({ 
        success: true, 
        message: "No active alerts",
        alertsChecked: 0,
        emailsSent: 0
      });
    }

    let emailsSent = 0;
    let alertsUpdated = false;

    // Check each alert
    for (const alert of activeAlerts) {
      console.log(`[CRON] Checking alert ${alert.id} for ${alert.brand} ${alert.model}`);

      // Find matching deals
      const matches = deals.filter(deal => dealMatchesAlert(deal, alert));

      if (matches.length > 0) {
        console.log(`[CRON] Found ${matches.length} matches for alert ${alert.id}`);

        // Check if we sent an email in the last 24 hours
        const lastNotified = alert.lastNotifiedAt || 0;
        const hoursSince = (now - lastNotified) / (1000 * 60 * 60);

        if (hoursSince >= 24 || !alert.lastNotifiedAt) {
          try {
            // Calculate days left
            const ageDays = Math.floor((now - alert.setAt) / (1000 * 60 * 60 * 24));
            const daysLeft = Math.max(0, 30 - ageDays);

            // Send email
            const emailHtml = generateMatchEmail(alert, matches, daysLeft);
            
            await sgMail.send({
              to: alert.email,
              from: process.env.SENDGRID_FROM_EMAIL,
              subject: `🎉 ${matches.length} Deal${matches.length > 1 ? 's' : ''} Found: ${alert.brand} ${alert.model}`,
              html: emailHtml
            });

            // Update lastNotifiedAt
            const alertIndex = alerts.findIndex(a => a.id === alert.id);
            if (alertIndex >= 0) {
              alerts[alertIndex].lastNotifiedAt = now;
              alertsUpdated = true;
            }

            emailsSent++;
            console.log(`[CRON] Email sent to ${alert.email}`);
          } catch (emailError) {
            console.error(`[CRON] Failed to send email for alert ${alert.id}:`, emailError);
          }
        } else {
          console.log(`[CRON] Skipping alert ${alert.id} (last notified ${hoursSince.toFixed(1)}h ago)`);
        }
      }
    }

    // Save updated alerts if any were notified
    if (alertsUpdated) {
      const { put } = require("@vercel/blob");
      await put("alerts.json", JSON.stringify({ alerts, lastUpdated: new Date().toISOString() }), {
        access: "public",
        addRandomSuffix: false
      });
      console.log("[CRON] Updated alerts.json with notification timestamps");
    }

    const duration = Date.now() - startTime;
    console.log(`[CRON] Check complete in ${duration}ms`);
    console.log(`[CRON] Alerts checked: ${activeAlerts.length}, Emails sent: ${emailsSent}`);

    return res.status(200).json({
      success: true,
      message: "Alert check completed",
      alertsChecked: activeAlerts.length,
      emailsSent: emailsSent,
      duration: duration
    });

  } catch (error) {
    console.error("[CRON] Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
};
