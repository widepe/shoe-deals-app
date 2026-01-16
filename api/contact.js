// api/contact.js
// Contact form submission endpoint using SendGrid

const sgMail = require("@sendgrid/mail");

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || CONTACT_EMAIL;

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
}

module.exports = async (req, res) => {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!SENDGRID_API_KEY || !CONTACT_EMAIL) {
    console.error("Missing SENDGRID_API_KEY or CONTACT_EMAIL env vars");
    return res
      .status(500)
      .json({ error: "Email service not configured on the server." });
  }

  try {
    const { name, email, message } = req.body || {};

    // Validate inputs (keeps your original checks)
    if (!name || !email || !message) {
      return res.status(400).json({ error: "All fields are required." });
    }

    if (!email.includes("@")) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    if (message.length < 10) {
      return res
        .status(400)
        .json({ error: "Message must be at least 10 characters." });
    }

    const safeName = String(name).trim();
    const safeEmail = String(email).trim();
    const safeMessage = String(message).trim();

    const subject = `New contact message from ${safeName || "Shoe Beagle visitor"}`;

    const textBody = `
New contact message from Shoe Beagle:

Name: ${safeName}
Email: ${safeEmail}

Message:
${safeMessage}
    `.trim();

    const htmlBody = `
      <p><strong>New contact message from Shoe Beagle:</strong></p>
      <p><strong>Name:</strong> ${safeName}</p>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-line;">${safeMessage}</p>
    `;

    const msg = {
      to: CONTACT_EMAIL,
      from: FROM_EMAIL,     // must be a verified sender in SendGrid
      replyTo: safeEmail,   // so you can just "Reply" in your inbox
      subject,
      text: textBody,
      html: htmlBody,
    };

    await sgMail.send(msg);

    return res.status(200).json({
      success: true,
      message: "Message sent! We'll get back to you soon.",
    });
  } catch (error) {
    console.error("Contact form error:", error);
    return res
      .status(500)
      .json({ error: "Failed to send message. Please try again." });
  }
};
