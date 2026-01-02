export default function handler(req, res) {
  const { query } = req.query;

  res.status(200).json({
    results: [
      {
        title: `${query} – Example Deal`,
        price: 99.99,
        store: "Demo Store",
        url: "https://example.com",
        image: "https://via.placeholder.com/300x200?text=Running+Shoe"
      }
    ]
  });
}
