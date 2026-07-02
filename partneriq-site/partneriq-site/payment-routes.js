// ═══════════════════════════════════════════════════════════════════
// PAYMENT ROUTES — add these to your existing server.js
// Add 'stripe' to your package.json dependencies:
//   "stripe": "^14.0.0"
// Add these environment variables to Render:
//   STRIPE_SECRET_KEY    — from stripe.com dashboard
//   STRIPE_WEBHOOK_SECRET — from stripe.com webhooks
//   PAYSTACK_SECRET_KEY  — from paystack.com dashboard
//   WEBSITE_URL          — https://partneriq.fit
// ═══════════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const crypto = require('crypto');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PRICING = {
  starter:      { zarCents: 49900,  usdCents: 2700 },
  professional: { zarCents: 99900, usdCents: 5500  },
};

// ── Helpers ───────────────────────────────────────────────────────

async function findOrCreateGroupForPurchase(email, name, tier) {
  // When someone pays on the marketing site they may not have
  // created a group yet. We create a "pending" group they can
  // then share with their team. The results code is what they paid for.
  const pool = global.__piqPool; // set in initDb() below — see note
  const words = ['FALCON','APEX','TITAN','NOVA','FORGE','ATLAS','PRISM','NEXUS'];
  let groupCode, exists = true;
  while (exists) {
    const w = words[Math.floor(Math.random() * words.length)];
    const n = Math.floor(Math.random() * 900) + 100;
    groupCode = `${w}-${n}`;
    const c = await pool.query('SELECT 1 FROM groups WHERE group_code = $1', [groupCode]);
    exists = c.rowCount > 0;
  }
  const rand = Math.random().toString(36).substr(2, 5).toUpperCase();
  const resultsCode = `KEY-${groupCode}-${rand}`;
  const groupName = `${name}'s Team`;

  await pool.query(
    'INSERT INTO groups (group_code, name, organiser, organiser_email, results_code) VALUES ($1,$2,$3,$4,$5)',
    [groupCode, groupName, name, email.toLowerCase(), resultsCode]
  );
  return { groupCode, resultsCode, groupName };
}

async function sendPurchaseEmail(email, name, tier, groupCode, resultsCode, appUrl) {
  // Re-uses the sendOrganiserPrivateEmail function from server.js
  // Call it here — it's available in scope when these routes are merged
  const tierName = tier === 'starter' ? 'Starter Report' : 'Full Intelligence Report';
  if (!global.__piqResend) return { sent: false };
  try {
    await global.__piqResend.emails.send({
      from: process.env.FROM_EMAIL || 'PartnerIQ <noreply@partneriq.fit>',
      to: email,
      subject: `Your PartnerIQ ${tierName} — codes inside`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
          <div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0">
            <h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400">PartnerIQ</h1>
            <p style="color:rgba(255,255,255,0.5);font-size:11px;margin:4px 0 0;letter-spacing:0.1em;text-transform:uppercase">${tierName}</p>
          </div>
          <div style="background:#fff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px">
            <p style="font-size:15px;margin:0 0 20px">Hi ${name},</p>
            <p style="font-size:14px;line-height:1.7;color:#4a4a6a;margin:0 0 20px">Thank you for your purchase. Your PartnerIQ ${tierName} is ready. Below are your codes.</p>

            <div style="background:#f7f4ef;border-radius:8px;padding:20px;margin-bottom:16px">
              <p style="font-size:11px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Share this with your team</p>
              <p style="font-size:26px;font-weight:700;color:#0f1e36;letter-spacing:4px;margin:0;font-family:monospace">${groupCode}</p>
              <p style="font-size:12px;color:#7a7a9a;margin:8px 0 0">Each person visits partneriq.fit, clicks "Take the quiz", and enters this code.</p>
            </div>

            <div style="background:#0f1e36;border-radius:8px;padding:20px;margin-bottom:24px">
              <p style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Your private results code — keep this safe</p>
              <p style="font-size:18px;font-weight:700;color:#c9a84c;letter-spacing:2px;margin:0;font-family:monospace;word-break:break-all">${resultsCode}</p>
            </div>

            <p style="font-size:13px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px">Next steps</p>
            <ol style="font-size:14px;line-height:1.9;color:#1a1a2e;padding-left:20px;margin:0 0 24px">
              <li>Share the group code with your team</li>
              <li>Everyone visits <a href="${appUrl}" style="color:#0f1e36">${appUrl}</a>, clicks "Take the quiz", enters the group code</li>
              <li>Once everyone is done, go to "View report" and enter your private results code</li>
            </ol>

            <a href="${appUrl}" style="display:block;text-align:center;padding:14px;background:#c9a84c;color:#0f1e36;font-weight:700;border-radius:8px;font-size:15px;text-decoration:none">Open PartnerIQ →</a>
          </div>
        </div>
      `
    });
    return { sent: true };
  } catch (e) {
    console.error('Purchase email error:', e.message);
    return { sent: false };
  }
}

// ── Stripe Checkout session ───────────────────────────────────────
module.exports.stripeCheckout = async function(req, res) {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { email, name, tier, currency } = req.body;
  if (!email || !tier || !PRICING[tier]) return res.status(400).json({ error: 'Invalid request' });

  const appUrl = process.env.APP_URL || 'https://partneriq.fit';
  const isUSD = currency === 'usd';
  const amount = isUSD ? PRICING[tier].usdCents : PRICING[tier].zarCents;
  const curr = isUSD ? 'usd' : 'zar';
  const tierName = tier === 'starter' ? 'Starter Report' : 'Full Intelligence Report';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: curr,
          product_data: { name: `PartnerIQ ${tierName}`, description: 'Team personality assessment and AI-generated group report' },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { email, name, tier, currency: curr },
      success_url: `${appUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/#pricing`,
    });
    res.json({ sessionUrl: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Stripe webhook (server confirmation) ─────────────────────────
module.exports.stripeWebhook = async function(req, res) {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, name, tier } = session.metadata;
    const appUrl = process.env.APP_URL || 'https://partneriq.fit';
    try {
      const { groupCode, resultsCode } = await findOrCreateGroupForPurchase(email, name, tier);
      await sendPurchaseEmail(email, name, tier, groupCode, resultsCode, appUrl);
      console.log(`Stripe payment confirmed: ${email} → ${tier} → ${groupCode}`);
    } catch (err) {
      console.error('Post-stripe processing error:', err.message);
    }
  }
  res.json({ received: true });
};

// ── Paystack webhook ──────────────────────────────────────────────
module.exports.paystackWebhook = async function(req, res) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '')
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (req.body.event === 'charge.success') {
    const data = req.body.data;
    const email = data.customer?.email;
    const name = data.metadata?.name || email;
    const tier = data.metadata?.tier || 'professional';
    const appUrl = process.env.APP_URL || 'https://partneriq.fit';
    try {
      const { groupCode, resultsCode } = await findOrCreateGroupForPurchase(email, name, tier);
      await sendPurchaseEmail(email, name, tier, groupCode, resultsCode, appUrl);
      console.log(`Paystack payment confirmed: ${email} → ${tier} → ${groupCode}`);
    } catch (err) {
      console.error('Post-paystack processing error:', err.message);
    }
  }
  res.sendStatus(200);
};

// ── Manual confirm endpoint (for inline Paystack popup) ───────────
module.exports.confirmPayment = async function(req, res) {
  const { email, name, tier, reference, provider } = req.body;
  if (!email || !tier) return res.status(400).json({ error: 'missing fields' });

  const appUrl = process.env.APP_URL || 'https://partneriq.fit';

  // Verify with Paystack if paystack payment
  if (provider === 'paystack' && process.env.PAYSTACK_SECRET_KEY) {
    try {
      const verify = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });
      const vData = await verify.json();
      if (!vData.status || vData.data?.status !== 'success') {
        return res.status(400).json({ error: 'Payment not verified' });
      }
    } catch (e) {
      console.error('Paystack verify error:', e.message);
      // Fail open in development, fail closed in production
      if (process.env.NODE_ENV === 'production') return res.status(500).json({ error: 'Verification failed' });
    }
  }

  try {
    const { groupCode, resultsCode } = await findOrCreateGroupForPurchase(email, name, tier);
    await sendPurchaseEmail(email, name, tier, groupCode, resultsCode, appUrl);
    res.json({ success: true, resultsCode, groupCode });
  } catch (err) {
    console.error('Confirm payment error:', err.message);
    res.status(500).json({ error: 'Failed to process payment confirmation' });
  }
};
