// Transactional email — provider-agnostic wrapper.
// Swap the fetch block for your provider (Shopify Email API, Postmark, Resend,
// SendGrid, etc.). Kept minimal so the rest of the app doesn't care which one.

export async function sendEmail({ to, subject, html }) {
  const key = process.env.EMAIL_PROVIDER_API_KEY;
  const from = process.env.EMAIL_FROM || "eparts@razoryn.co.uk";
  if (!key) {
    console.warn("[email] no EMAIL_PROVIDER_API_KEY set — skipping send to", to);
    return false;
  }
  try {
    // Example shape (Resend). Replace endpoint/body for your provider.
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return true;
  } catch (err) {
    console.error("[email] send failed", err);
    return false;
  }
}
