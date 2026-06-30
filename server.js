require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Database setup ────────────────────────────────────────────────────────────
// Render PostgreSQL provides DATABASE_URL automatically once a Postgres
// instance is attached to this service. SSL is required on Render's managed PG.
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
  console.log('Database tables ready');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
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

async function sendResultsCodeEmail(toEmail, groupName, groupCode, resultsCode) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — skipping email send. Results code:', resultsCode);
    return { sent: false, reason: 'Email not configured' };
  }
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `Your PartnerIQ results code for "${groupName}"`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">
          <h2 style="color:#0f1e36">PartnerIQ</h2>
          <p>Your group <strong>${groupName}</strong> has been created.</p>
          <p style="margin-top:20px"><strong>Group code (share with participants):</strong><br>
          <span style="font-size:20px;color:#0f1e36;letter-spacing:1px">${groupCode}</span></p>
          <p style="margin-top:20px"><strong>Your private results code (keep this safe):</strong><br>
          <span style="font-size:18px;color:#c9a84c;letter-spacing:1px">${resultsCode}</span></p>
          <p style="margin-top:20px;color:#7a7a9a;font-size:13px">
            Save this email — this results code is the only way to access your group's full report.
            There is no password reset; if you lose this code, use the recovery option on the site
            with this same email address.
          </p>
        </div>
      `
    });
    return { sent: true };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendVerificationCodeEmail(toEmail, code) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — skipping verification email. Code:', code);
    return { sent: false, reason: 'Email not configured' };
  }
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `Your PartnerIQ verification code: ${code}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#1a1a2e">
          <h2 style="color:#0f1e36">PartnerIQ</h2>
          <p>Enter this code to verify your email and start your assessment:</p>
          <p style="margin:24px 0;text-align:center">
            <span style="font-size:32px;font-weight:700;color:#0f1e36;letter-spacing:6px">${code}</span>
          </p>
          <p style="color:#7a7a9a;font-size:13px">This code expires in 15 minutes. If you didn't request this, you can ignore this email.</p>
        </div>
      `
    });
    return { sent: true };
  } catch (err) {
    console.error('Verification email failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendPersonalReportEmail(toEmail, name, archetype, traits, reportText) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — skipping personal report email.');
    return { sent: false, reason: 'Email not configured' };
  }
  const traitRows = Object.entries(traits).map(([k, v]) =>
    `<tr><td style="padding:4px 0;color:#4a4a6a;font-size:13px">${k}</td><td style="padding:4px 0;text-align:right;font-weight:600;color:#0f1e36">${v}%</td></tr>`
  ).join('');
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `Your PartnerIQ personal profile — ${archetype}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;color:#1a1a2e">
          <h2 style="color:#0f1e36">PartnerIQ</h2>
          <p>Hi ${name}, here's your personal partnership profile — yours to keep.</p>
          <p style="display:inline-block;background:#0f1e36;color:#c9a84c;font-size:12px;font-weight:700;padding:6px 14px;border-radius:999px;margin:12px 0">${archetype}</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">${traitRows}</table>
          <div style="white-space:pre-wrap;font-size:14px;line-height:1.7;color:#1a1a2e;margin-top:20px">${reportText}</div>
          <p style="color:#7a7a9a;font-size:12px;margin-top:24px">
            This profile is yours alone. Your group's full compatibility report is only visible to your organiser.
          </p>
        </div>
      `
    });
    return { sent: true };
  } catch (err) {
    console.error('Personal report email failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Group API ─────────────────────────────────────────────────────────────────

app.post('/api/groups', async (req, res) => {
  const { name, organiser, organiserEmail } = req.body;
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
      'INSERT INTO groups (group_code, name, organiser, organiser_email, results_code) VALUES ($1,$2,$3,$4,$5)',
      [groupCode, name, organiser, organiserEmail || null, resultsCode]
    );

    let emailResult = { sent: false, reason: 'No email provided' };
    if (organiserEmail) {
      emailResult = await sendResultsCodeEmail(organiserEmail, name, groupCode, resultsCode);
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

// ── Email verification (required before taking the quiz) ─────────────────────

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
    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
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
    if (verifiedCheck.rowCount === 0) {
      return res.status(403).json({ error: 'Email not verified for this group' });
    }

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
    const membersResult = await pool.query('SELECT name, roles, traits, archetype, submitted FROM members WHERE group_code = $1 ORDER BY submitted ASC', [group.group_code]);

    if (membersResult.rowCount === 0) return res.status(400).json({ error: 'No submissions yet' });

    res.json({
      name: group.name,
      organiser: group.organiser,
      groupCode: group.group_code,
      members: membersResult.rows.map(m => ({
        name: m.name,
        roles: m.roles,
        traits: m.traits,
        archetype: m.archetype,
        submitted: m.submitted
      }))
    });
  } catch (err) {
    console.error('Get results error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Recovery: resend results code by email ────────────────────────────────────
app.post('/api/recover', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const result = await pool.query(
      'SELECT group_code, name, results_code FROM groups WHERE organiser_email = $1 ORDER BY created DESC',
      [email]
    );
    if (result.rowCount === 0) {
      // Don't reveal whether the email exists or not — generic response either way
      return res.json({ message: 'If that email has any groups on file, codes have been resent.' });
    }

    for (const grp of result.rows) {
      await sendResultsCodeEmail(email, grp.name, grp.group_code, grp.results_code);
    }
    res.json({ message: 'If that email has any groups on file, codes have been resent.' });
  } catch (err) {
    console.error('Recovery error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Send personal report email (called after AI generates the report client-side) ──
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
    }, { timeout: 40000 }); // 40s hard timeout on the Anthropic SDK call itself
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

// ── Serve frontend for all other routes ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`PartnerIQ running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialise database:', err);
    process.exit(1);
  });
