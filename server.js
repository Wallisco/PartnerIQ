require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database setup ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      group_code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      organiser TEXT NOT NULL,
      organiser_email TEXT,
      results_code TEXT UNIQUE NOT NULL,
      context JSONB DEFAULT '{}',
      created TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      group_code TEXT REFERENCES groups(group_code) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT,
      roles JSONB DEFAULT '[]',
      traits JSONB NOT NULL,
      archetype TEXT,
      submitted TIMESTAMPTZ DEFAULT now(),
      UNIQUE(group_code, name)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id SERIAL PRIMARY KEY,
      group_code TEXT NOT NULL,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      verified BOOLEAN DEFAULT false,
      created TIMESTAMPTZ DEFAULT now(),
      expires TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      tier TEXT NOT NULL,
      provider TEXT NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      group_code TEXT,
      results_code TEXT,
      status TEXT DEFAULT 'pending',
      created TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Safe migrations
  await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS context JSONB DEFAULT '{}'`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS email TEXT`);
  console.log('Database tables ready');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
// Stripe webhooks need raw body — must come BEFORE express.json()
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Code generation ───────────────────────────────────────────────────────────
function genCode() {
  const words = ['FALCON','APEX','TITAN','NOVA','FORGE','ATLAS','PRISM','NEXUS','CREST','DELTA','VEGA','ORION'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 900) + 100;
  return `${w}-${n}`;
}
function genResultsCode(groupCode) {
  const rand = Math.random().toString(36).substr(2, 5).toUpperCase();
  return `KEY-${groupCode}-${rand}`;
}

// ── Email (Resend) ────────────────────────────────────────────────────────────
let resend = null;
if (process.env.RESEND_API_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
}
const FROM_EMAIL = process.env.FROM_EMAIL || 'PartnerIQ <onboarding@resend.dev>';

async function sendGroupCodeEmail(toEmail, groupName, groupCode, appUrl) {
  if (!resend) { console.warn('RESEND_API_KEY not set — skipping group code email.'); return { sent: false }; }
  const url = appUrl || 'https://partneriq.fit';
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: toEmail,
      subject: `You've been invited to take the PartnerIQ assessment — ${groupName}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e"><div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0"><h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400">PartnerIQ</h1><p style="color:rgba(255,255,255,0.5);font-size:11px;margin:4px 0 0;letter-spacing:0.1em;text-transform:uppercase">Partnership Intelligence</p></div><div style="background:#fff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px"><p style="font-size:15px;margin:0 0 16px">Hi,</p><p style="font-size:15px;line-height:1.6;margin:0 0 20px">You've been invited to complete a partnership intelligence assessment for <strong>${groupName}</strong>. This takes about 8 minutes and will give you a personal personality and business-style profile — yours to keep.</p><p style="font-size:13px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px">How to take the assessment</p><ol style="font-size:14px;line-height:1.9;color:#1a1a2e;padding-left:20px;margin:0 0 24px"><li>Go to <a href="${url}" style="color:#0f1e36;font-weight:600">${url}</a></li><li>Click <strong>"Take the quiz"</strong></li><li>Enter the group code below</li><li>Verify your email and complete the 20 questions</li><li>Your personal profile will be shown immediately and emailed to you</li></ol><div style="background:#f7f4ef;border-radius:8px;padding:20px;text-align:center;margin:0 0 24px"><p style="font-size:11px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px">Your group code</p><p style="font-size:28px;font-weight:700;color:#0f1e36;letter-spacing:4px;margin:0;font-family:monospace">${groupCode}</p></div><p style="font-size:13px;color:#7a7a9a;line-height:1.6;margin:0">Once you've completed the assessment, the group organiser will be in touch with the full partnership report. Your individual profile is yours regardless — check your inbox after you submit.</p></div><p style="font-size:11px;color:#b0aaa0;text-align:center;margin:16px 0 0">PartnerIQ · <a href="${url}" style="color:#b0aaa0">${url}</a></p></div>`
    });
    return { sent: true };
  } catch (err) { console.error('Group code email failed:', err.message); return { sent: false, reason: err.message }; }
}

async function sendOrganiserPrivateEmail(toEmail, groupName, groupCode, resultsCode, appUrl) {
  if (!resend) { console.warn('RESEND_API_KEY not set — results code:', resultsCode); return { sent: false }; }
  const url = appUrl || 'https://partneriq.fit';
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: toEmail,
      subject: `PartnerIQ — your private codes for "${groupName}"`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e"><div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0"><h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400">PartnerIQ</h1><p style="color:rgba(255,255,255,0.5);font-size:11px;margin:4px 0 0;letter-spacing:0.1em;text-transform:uppercase">Group organiser — keep this email private</p></div><div style="background:#fff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px"><p style="font-size:15px;margin:0 0 20px">Your group <strong>${groupName}</strong> has been created. Below are your two codes — one to share with your team, one to keep private.</p><div style="background:#f7f4ef;border-radius:8px;padding:20px;margin:0 0 16px"><p style="font-size:11px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Group code — share this with your team</p><p style="font-size:26px;font-weight:700;color:#0f1e36;letter-spacing:4px;margin:0;font-family:monospace">${groupCode}</p><p style="font-size:12px;color:#7a7a9a;margin:8px 0 0">A separate invitation email has also been sent to you — forward that one directly to your team members.</p></div><div style="background:#0f1e36;border-radius:8px;padding:20px;margin:0 0 24px"><p style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Your private results code — do not share this</p><p style="font-size:20px;font-weight:700;color:#c9a84c;letter-spacing:2px;margin:0;font-family:monospace;word-break:break-all">${resultsCode}</p><p style="font-size:12px;color:rgba(255,255,255,0.4);margin:8px 0 0">This is the only way to unlock the full group report. Save it somewhere safe. If you lose it, use the "Recover it by email" link on the site.</p></div><ol style="font-size:14px;line-height:1.9;color:#1a1a2e;padding-left:20px;margin:0 0 24px"><li>Forward the other email to everyone in your group</li><li>Wait for all participants to complete the assessment</li><li>Go to <a href="${url}" style="color:#0f1e36;font-weight:600">${url}</a> → "View report"</li><li>Enter your private results code above to unlock the full report</li></ol></div><p style="font-size:11px;color:#b0aaa0;text-align:center;margin:16px 0 0">PartnerIQ · <a href="${url}" style="color:#b0aaa0">${url}</a></p></div>`
    });
    return { sent: true };
  } catch (err) { console.error('Organiser private email failed:', err.message); return { sent: false, reason: err.message }; }
}

async function sendVerificationCodeEmail(toEmail, code) {
  if (!resend) { console.warn('RESEND_API_KEY not set — verification code:', code); return { sent: false }; }
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: toEmail,
      subject: `Your PartnerIQ verification code: ${code}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e"><div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0"><h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400">PartnerIQ</h1></div><div style="background:#fff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px"><p style="font-size:15px;margin:0 0 16px">Enter this code to verify your email and start your assessment:</p><p style="margin:24px 0;text-align:center"><span style="font-size:36px;font-weight:700;color:#0f1e36;letter-spacing:8px;font-family:monospace">${code}</span></p><p style="color:#7a7a9a;font-size:13px">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p></div></div>`
    });
    return { sent: true };
  } catch (err) { console.error('Verification email failed:', err.message); return { sent: false, reason: err.message }; }
}

async function sendPersonalReportEmail(toEmail, name, archetype, traits, reportText) {
  if (!resend) { console.warn('RESEND_API_KEY not set — skipping personal report email.'); return { sent: false }; }
  const traitRows = Object.entries(traits).map(([k, v]) =>
    `<tr><td style="padding:4px 0;color:#4a4a6a;font-size:13px">${k}</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#0f1e36">${v}%</td></tr>`
  ).join('');
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: toEmail,
      subject: `Your PartnerIQ personal profile — ${archetype}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:#1a1a2e"><div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0"><h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400">PartnerIQ</h1></div><div style="background:#fff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px"><p style="font-size:15px;margin:0 0 12px">Hi ${name}, here's your personal partnership profile — yours to keep.</p><p style="display:inline-block;background:#0f1e36;color:#c9a84c;font-size:12px;font-weight:700;padding:6px 14px;border-radius:999px;margin:0 0 16px">${archetype}</p><table style="width:100%;border-collapse:collapse;margin:0 0 20px">${traitRows}</table><div style="white-space:pre-wrap;font-size:14px;line-height:1.75;color:#1a1a2e">${reportText}</div><p style="color:#7a7a9a;font-size:12px;margin-top:24px">This profile is yours alone. Your group's full compatibility report is only visible to your organiser.</p></div></div>`
    });
    return { sent: true };
  } catch (err) { console.error('Personal report email failed:', err.message); return { sent: false, reason: err.message }; }
}

async function sendPurchaseConfirmationEmail(toEmail, name, tier, groupCode, resultsCode, appUrl) {
  if (!resend) { console.warn('RESEND_API_KEY not set — skipping purchase email.'); return { sent: false }; }
  const url = appUrl || 'https://partneriq.fit';
  const tierName = tier === 'starter' ? 'Starter Report' : 'Full Intelligence Report';
  try {
    await resend.emails.send({
      from: FROM_EMAIL, to: toEmail,
      subject: `Your PartnerIQ ${tierName} — codes inside`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e"><div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0"><h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400">PartnerIQ</h1><p style="color:rgba(255,255,255,0.5);font-size:11px;margin:4px 0 0;letter-spacing:0.1em;text-transform:uppercase">${tierName} — Payment confirmed</p></div><div style="background:#fff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px"><p style="font-size:15px;margin:0 0 20px">Hi ${name}, thank you for your purchase. Your PartnerIQ ${tierName} is ready.</p><div style="background:#f7f4ef;border-radius:8px;padding:20px;margin:0 0 16px"><p style="font-size:11px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Share this with your team</p><p style="font-size:26px;font-weight:700;color:#0f1e36;letter-spacing:4px;margin:0;font-family:monospace">${groupCode}</p><p style="font-size:12px;color:#7a7a9a;margin:8px 0 0">Each person visits ${url}, clicks "Take the quiz", and enters this code.</p></div><div style="background:#0f1e36;border-radius:8px;padding:20px;margin:0 0 24px"><p style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Your private results code — keep this safe</p><p style="font-size:18px;font-weight:700;color:#c9a84c;letter-spacing:2px;margin:0;font-family:monospace;word-break:break-all">${resultsCode}</p></div><ol style="font-size:14px;line-height:1.9;color:#1a1a2e;padding-left:20px;margin:0 0 24px"><li>Share the group code with your team</li><li>Everyone visits <a href="${url}" style="color:#0f1e36">${url}</a>, takes the quiz, enters the group code</li><li>Once done, go to "View report" and enter your private results code</li></ol><a href="${url}" style="display:block;text-align:center;padding:14px;background:#c9a84c;color:#0f1e36;font-weight:700;border-radius:8px;font-size:15px;text-decoration:none">Open PartnerIQ →</a></div><p style="font-size:11px;color:#b0aaa0;text-align:center;margin:16px 0 0">PartnerIQ · <a href="${url}" style="color:#b0aaa0">${url}</a></p></div>`
    });
    return { sent: true };
  } catch (err) { console.error('Purchase email failed:', err.message); return { sent: false, reason: err.message }; }
}

// ── Payment helpers ───────────────────────────────────────────────────────────
const PRICING = {
  starter:      { zarCents: 49900,  usdCents: 2700,  name: 'Starter Report' },
  professional: { zarCents: 99900,  usdCents: 5500,  name: 'Full Intelligence Report' },
};

async function createGroupForPurchase(email, name) {
  let groupCode, exists = true;
  while (exists) {
    groupCode = genCode();
    const c = await pool.query('SELECT 1 FROM groups WHERE group_code = $1', [groupCode]);
    exists = c.rowCount > 0;
  }
  const resultsCode = genResultsCode(groupCode);
  const groupName = `${name}'s Team`;
  await pool.query(
    'INSERT INTO groups (group_code, name, organiser, organiser_email, results_code) VALUES ($1,$2,$3,$4,$5)',
    [groupCode, groupName, name, email.toLowerCase(), resultsCode]
  );
  return { groupCode, resultsCode, groupName };
}

async function fulfilPayment(email, name, tier, reference, provider) {
  // Check if already fulfilled (idempotency)
  const existing = await pool.query('SELECT group_code, results_code FROM payments WHERE reference = $1 AND status = $2', [reference, 'fulfilled']);
  if (existing.rowCount > 0) {
    return { groupCode: existing.rows[0].group_code, resultsCode: existing.rows[0].results_code, alreadyFulfilled: true };
  }
  const { groupCode, resultsCode } = await createGroupForPurchase(email, name);
  await pool.query(
    `INSERT INTO payments (email, name, tier, provider, reference, group_code, results_code, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'fulfilled')
     ON CONFLICT (reference) DO UPDATE SET status='fulfilled', group_code=$6, results_code=$7`,
    [email.toLowerCase(), name, tier, provider, reference, groupCode, resultsCode]
  );
  await sendPurchaseConfirmationEmail(email, name, tier, groupCode, resultsCode, process.env.APP_URL);
  console.log(`Payment fulfilled: ${provider} | ${email} | ${tier} | ${groupCode}`);
  return { groupCode, resultsCode };
}

// ── Stripe ────────────────────────────────────────────────────────────────────
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

app.post('/api/payments/stripe-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured — add STRIPE_SECRET_KEY to environment variables' });
  const { email, name, tier, currency } = req.body;
  if (!email || !tier || !PRICING[tier]) return res.status(400).json({ error: 'Invalid request' });

  const appUrl = process.env.APP_URL || 'https://partneriq.fit';
  const isUSD = currency === 'usd';
  const amount = isUSD ? PRICING[tier].usdCents : PRICING[tier].zarCents;
  const curr = isUSD ? 'usd' : 'zar';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: curr,
          product_data: { name: `PartnerIQ ${PRICING[tier].name}`, description: 'AI-powered team personality assessment and group intelligence report' },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { email, name, tier },
      success_url: `${appUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/#pricing`,
    });
    res.json({ sessionUrl: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook — raw body required (middleware set at top)
app.post('/api/webhooks/stripe', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { email, name, tier } = session.metadata;
    try {
      await fulfilPayment(email, name, tier, session.id, 'stripe');
    } catch (err) {
      console.error('Stripe fulfilment error:', err.message);
    }
  }
  res.json({ received: true });
});

// Payment success page — Stripe redirects here after checkout
app.get('/payment-success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Paystack ──────────────────────────────────────────────────────────────────
app.post('/api/webhooks/paystack', async (req, res) => {
  if (!process.env.PAYSTACK_SECRET_KEY) return res.sendStatus(200);
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (req.body.event === 'charge.success') {
    const data = req.body.data;
    const email = data.customer?.email || '';
    const name = data.metadata?.name || email;
    const tier = data.metadata?.tier || 'professional';
    const reference = data.reference;
    try {
      await fulfilPayment(email, name, tier, reference, 'paystack');
    } catch (err) {
      console.error('Paystack fulfilment error:', err.message);
    }
  }
  res.sendStatus(200);
});

// Paystack inline popup confirm — called client-side after popup closes successfully
app.post('/api/payments/confirm', async (req, res) => {
  const { email, name, tier, reference, provider } = req.body;
  if (!email || !tier || !reference) return res.status(400).json({ error: 'missing fields' });

  // Verify with Paystack before fulfilling
  if (provider === 'paystack' && process.env.PAYSTACK_SECRET_KEY) {
    try {
      const verify = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });
      const vData = await verify.json();
      if (!vData.status || vData.data?.status !== 'success') {
        return res.status(400).json({ error: 'Payment not verified with Paystack' });
      }
    } catch (err) {
      console.error('Paystack verify error:', err.message);
      if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({ error: 'Could not verify payment — please contact hello@partneriq.fit' });
      }
    }
  }

  try {
    const { groupCode, resultsCode } = await fulfilPayment(email, name, tier, reference, provider || 'paystack');
    res.json({ success: true, groupCode, resultsCode });
  } catch (err) {
    console.error('Confirm payment error:', err.message);
    res.status(500).json({ error: 'Payment confirmed but fulfilment failed — codes will be emailed shortly' });
  }
});

// ── Group API ─────────────────────────────────────────────────────────────────
app.post('/api/groups', async (req, res) => {
  const { name, organiser, organiserEmail, context } = req.body;
  if (!name || !organiser) return res.status(400).json({ error: 'name and organiser required' });
  try {
    let groupCode, exists = true;
    while (exists) {
      groupCode = genCode();
      const check = await pool.query('SELECT 1 FROM groups WHERE group_code = $1', [groupCode]);
      exists = check.rowCount > 0;
    }
    const resultsCode = genResultsCode(groupCode);
    await pool.query(
      'INSERT INTO groups (group_code, name, organiser, organiser_email, results_code, context) VALUES ($1,$2,$3,$4,$5,$6)',
      [groupCode, name, organiser, organiserEmail || null, resultsCode, JSON.stringify(context || {})]
    );
    let emailResult = { sent: false, reason: 'No email provided' };
    if (organiserEmail) {
      const [groupEmail, organiserEmail2] = await Promise.all([
        sendGroupCodeEmail(organiserEmail, name, groupCode, process.env.APP_URL),
        sendOrganiserPrivateEmail(organiserEmail, name, groupCode, resultsCode, process.env.APP_URL)
      ]);
      emailResult = { sent: groupEmail.sent && organiserEmail2.sent };
    }
    res.json({ groupCode, resultsCode, emailSent: emailResult.sent });
  } catch (err) {
    console.error('Create group error:', err);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

app.get('/api/groups/:code', async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const result = await pool.query('SELECT name, organiser FROM groups WHERE group_code = $1', [code]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const memberCount = await pool.query('SELECT COUNT(*) FROM members WHERE group_code = $1', [code]);
    res.json({ name: result.rows[0].name, organiser: result.rows[0].organiser, memberCount: parseInt(memberCount.rows[0].count) });
  } catch (err) {
    console.error('Get group error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Email verification ────────────────────────────────────────────────────────
app.post('/api/groups/:code/send-verification', async (req, res) => {
  const { email } = req.body;
  const code = req.params.code.toUpperCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const groupCheck = await pool.query('SELECT 1 FROM groups WHERE group_code = $1', [code]);
    if (groupCheck.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'INSERT INTO email_verifications (group_code, email, code, expires) VALUES ($1,$2,$3,$4)',
      [code, email.toLowerCase().trim(), verifyCode, expires]
    );
    const emailResult = await sendVerificationCodeEmail(email, verifyCode);
    res.json({ sent: emailResult.sent, reason: emailResult.reason || null });
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ error: 'Failed to send verification code' });
  }
});

app.post('/api/groups/:code/verify-email', async (req, res) => {
  const { email, verifyCode } = req.body;
  const code = req.params.code.toUpperCase();
  if (!email || !verifyCode) return res.status(400).json({ error: 'email and verifyCode required' });
  try {
    const result = await pool.query(
      `SELECT id FROM email_verifications
       WHERE group_code = $1 AND email = $2 AND code = $3 AND verified = false AND expires > now()
       ORDER BY created DESC LIMIT 1`,
      [code, email.toLowerCase().trim(), verifyCode.trim()]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: 'Invalid or expired code' });
    await pool.query('UPDATE email_verifications SET verified = true WHERE id = $1', [result.rows[0].id]);
    res.json({ verified: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/groups/:code/submit', async (req, res) => {
  const { name, email, roles, traits, archetype } = req.body;
  if (!name || !traits) return res.status(400).json({ error: 'name and traits required' });
  if (!email) return res.status(400).json({ error: 'verified email required' });
  try {
    const code = req.params.code.toUpperCase();
    const groupCheck = await pool.query('SELECT 1 FROM groups WHERE group_code = $1', [code]);
    if (groupCheck.rowCount === 0) return res.status(404).json({ error: 'Group not found' });
    const verifiedCheck = await pool.query(
      `SELECT 1 FROM email_verifications WHERE group_code = $1 AND email = $2 AND verified = true
       ORDER BY created DESC LIMIT 1`,
      [code, email.toLowerCase().trim()]
    );
    if (verifiedCheck.rowCount === 0) return res.status(403).json({ error: 'Email not verified for this group' });
    await pool.query(
      `INSERT INTO members (group_code, name, email, roles, traits, archetype)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (group_code, name)
       DO UPDATE SET email = $3, roles = $4, traits = $5, archetype = $6, submitted = now()`,
      [code, name, email.toLowerCase().trim(), JSON.stringify(roles || []), JSON.stringify(traits), archetype]
    );
    const memberCount = await pool.query('SELECT COUNT(*) FROM members WHERE group_code = $1', [code]);
    res.json({ success: true, memberCount: parseInt(memberCount.rows[0].count) });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to save response' });
  }
});

app.get('/api/results/:resultsCode', async (req, res) => {
  try {
    const resultsCode = req.params.resultsCode.toUpperCase();
    const groupResult = await pool.query('SELECT * FROM groups WHERE results_code = $1', [resultsCode]);
    if (groupResult.rowCount === 0) return res.status(404).json({ error: 'Results code not found' });
    const group = groupResult.rows[0];
    const membersResult = await pool.query(
      'SELECT name, roles, traits, archetype, submitted FROM members WHERE group_code = $1 ORDER BY submitted ASC',
      [group.group_code]
    );
    if (membersResult.rowCount === 0) return res.status(400).json({ error: 'No submissions yet' });
    res.json({
      name: group.name,
      organiser: group.organiser,
      groupCode: group.group_code,
      context: group.context || {},
      members: membersResult.rows.map(m => ({
        name: m.name, roles: m.roles, traits: m.traits, archetype: m.archetype, submitted: m.submitted
      }))
    });
  } catch (err) {
    console.error('Get results error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Recovery ──────────────────────────────────────────────────────────────────
app.post('/api/recover', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const result = await pool.query(
      'SELECT group_code, name, results_code FROM groups WHERE organiser_email = $1 ORDER BY created DESC',
      [email]
    );
    if (result.rowCount > 0) {
      for (const grp of result.rows) {
        await sendGroupCodeEmail(email, grp.name, grp.group_code, process.env.APP_URL);
        await sendOrganiserPrivateEmail(email, grp.name, grp.group_code, grp.results_code, process.env.APP_URL);
      }
    }
    res.json({ message: 'If that email has any groups on file, codes have been resent.' });
  } catch (err) {
    console.error('Recovery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Personal report email ─────────────────────────────────────────────────────
app.post('/api/send-personal-report', async (req, res) => {
  const { email, name, archetype, traits, reportText } = req.body;
  if (!email || !name || !traits || !reportText) return res.status(400).json({ error: 'missing fields' });
  try {
    const result = await sendPersonalReportEmail(email, name, archetype, traits, reportText);
    res.json({ sent: result.sent, reason: result.reason || null });
  } catch (err) {
    console.error('Send personal report error:', err);
    res.status(500).json({ error: 'Failed to send report email' });
  }
});

// ── Anthropic API proxy ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/api/ai/analyse', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API key not configured' });
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }, { timeout: 40000 });
    res.json({ result: message.content.map(b => b.text || '').join('') });
  } catch (err) {
    console.error('Anthropic error:', err.message, err.status || '', err.error || '');
    res.status(500).json({ error: 'AI analysis failed', detail: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', detail: err.message });
  }
});

// ── Catch-all — serve frontend ────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`PartnerIQ running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
