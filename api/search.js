export default function handler(req, res) {
  const { query } = req.query;

  res.status(200).json({
    results: [
      {
        title: `${query} – Example Deal`,
        price: 99.99,
        store: "Demo Store",
        url: "https://example.com",
image: "https://placehold.co/600x400?text=Running+Shoe"
    ]
  });
}
