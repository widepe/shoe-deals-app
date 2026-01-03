module.exports = (req, res) => {
  const requestId =
    (req.headers && (req.headers["x-vercel-id"] || req.headers["x-request-id"])) ||
    `local-${Date.now()}`;

  const startedAt = Date.now();

  try {
    // Read query safely
    const rawQuery = req.query && req.query.query ? req.query.query : "";
    const query = String(rawQuery).trim();

    // Basic request log
    console.log("[/api/search] start", {
      requestId,
      method: req.method,
      query,
      userAgent: req.headers && req.headers["user-agent"],
      // Keep logs safe: do NOT log emails/phones later when you add alerts
    });

    // Validate input
    if (!query) {
      res.status(400).json({
        error: "Missing query parameter",
        example: "/api/search?query=Nike%20Pegasus",
        requestId
      });
      console.log("[/api/search] done (400)", {
        requestId,
        ms: Date.now() - startedAt
      });
      return;
    }

    // Demo results (placeholder)
    const results = [
      {
        title: `${query} – Example Deal`,
        price: 99.99,
        store: "Demo Store",
        url: "https://example.com",
        image: "https://placehold.co/600x400?text=Running+Shoe"
      }
    ];

    // Success response
    res.status(200).json({ results, requestId });

    console.log("[/api/search] done (200)", {
      requestId,
      ms: Date.now() - startedAt,
      count: results.length
    });
  } catch (err) {
    // Always catch errors so the function doesn't crash
    console.error("[/api/search] error", {
      requestId,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    });

    res.status(500).json({
      error: "Internal server error",
      requestId
    });

    console.log("[/api/search] done (500)", {
      requestId,
      ms: Date.now() - startedAt
    });
  }
};
