module.exports = (req, res) => {
  try {
    const query = (req.query && req.query.query) ? String(req.query.query) : "";

    res.status(200).json({
      results: [
        {
          title: `${query} – Example Deal`,
          price: 99.99,
          store: "Demo Store",
          url: "https://example.com",
          image: "https://placehold.co/600x400?text=Running+Shoe"
        }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: "Server error", details: String(err) });
  }
};
