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
  // Add context column to existing tables if not present (safe migration)
  await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS context JSONB DEFAULT '{}'`);
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

// Email 1 — Group code only, worded so the organiser can forward directly to their team
async function sendGroupCodeEmail(toEmail, groupName, groupCode, appUrl) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — skipping group code email.');
    return { sent: false, reason: 'Email not configured' };
  }
  const url = appUrl || 'https://partneriq.fit';
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `You've been invited to take the PartnerIQ assessment — ${groupName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
          <div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0">
            <h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400;letter-spacing:0.02em">PartnerIQ</h1>
            <p style="color:rgba(255,255,255,0.5);font-size:11px;margin:4px 0 0;letter-spacing:0.1em;text-transform:uppercase">Partnership Intelligence</p>
          </div>
          <div style="background:#ffffff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px">
            <p style="font-size:15px;margin:0 0 16px">Hi,</p>
            <p style="font-size:15px;line-height:1.6;margin:0 0 20px">
              You've been invited to complete a partnership intelligence assessment for
              <strong>${groupName}</strong>. This takes about 8 minutes and will give you a
              personal personality and business-style profile — yours to keep.
            </p>

            <p style="font-size:13px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px">How to take the assessment</p>
            <ol style="font-size:14px;line-height:1.9;color:#1a1a2e;padding-left:20px;margin:0 0 24px">
              <li>Go to <a href="${url}" style="color:#0f1e36;font-weight:600">${url}</a></li>
              <li>Click <strong>"Take the quiz"</strong></li>
              <li>Enter the group code below</li>
              <li>Verify your email and complete the 20 questions</li>
              <li>Your personal profile will be shown immediately and emailed to you</li>
            </ol>

            <div style="background:#f7f4ef;border-radius:8px;padding:20px;text-align:center;margin:0 0 24px">
              <p style="font-size:11px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 8px">Your group code</p>
              <p style="font-size:28px;font-weight:700;color:#0f1e36;letter-spacing:4px;margin:0;font-family:monospace">${groupCode}</p>
            </div>

            <p style="font-size:13px;color:#7a7a9a;line-height:1.6;margin:0">
              Once you've completed the assessment, the group organiser will be in touch with the
              full partnership report. Your individual profile is yours regardless — check your
              inbox after you submit.
            </p>
          </div>
          <p style="font-size:11px;color:#b0aaa0;text-align:center;margin:16px 0 0">
            PartnerIQ · Partnership Intelligence · <a href="${url}" style="color:#b0aaa0">${url}</a>
          </p>
        </div>
      `
    });
    return { sent: true };
  } catch (err) {
    console.error('Group code email failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

// Email 2 — Organiser's private email with BOTH codes and full instructions
async function sendOrganiserPrivateEmail(toEmail, groupName, groupCode, resultsCode, appUrl) {
  if (!resend) {
    console.warn('RESEND_API_KEY not set — skipping organiser private email. Results code:', resultsCode);
    return { sent: false, reason: 'Email not configured' };
  }
  const url = appUrl || 'https://partneriq.fit';
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `PartnerIQ — your private codes for "${groupName}"`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
          <div style="background:#0f1e36;padding:24px 28px;border-radius:8px 8px 0 0">
            <h1 style="color:#c9a84c;font-size:22px;margin:0;font-weight:400;letter-spacing:0.02em">PartnerIQ</h1>
            <p style="color:rgba(255,255,255,0.5);font-size:11px;margin:4px 0 0;letter-spacing:0.1em;text-transform:uppercase">Group organiser — keep this email private</p>
          </div>
          <div style="background:#ffffff;padding:28px;border:1px solid #e8e4db;border-top:none;border-radius:0 0 8px 8px">
            <p style="font-size:15px;margin:0 0 20px">
              Your group <strong>${groupName}</strong> has been created. Below are your two codes —
              one to share with your team, one to keep private.
            </p>

            <div style="background:#f7f4ef;border-radius:8px;padding:20px;margin:0 0 16px">
              <p style="font-size:11px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Group code — share this with your team</p>
              <p style="font-size:26px;font-weight:700;color:#0f1e36;letter-spacing:4px;margin:0;font-family:monospace">${groupCode}</p>
              <p style="font-size:12px;color:#7a7a9a;margin:8px 0 0">
                A separate invitation email has also been sent to you — forward that one directly to your team members.
                It contains everything they need with no private information visible.
              </p>
            </div>

            <div style="background:#0f1e36;border-radius:8px;padding:20px;margin:0 0 24px">
              <p style="font-size:11px;font-weight:600;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.1em;margin:0 0 6px">Your private results code — do not share this</p>
              <p style="font-size:20px;font-weight:700;color:#c9a84c;letter-spacing:2px;margin:0;font-family:monospace;word-break:break-all">${resultsCode}</p>
              <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:8px 0 0">
                This is the only way to unlock the full group report. Save it somewhere safe.
                If you lose it, use the "Recover it by email" link on the site.
              </p>
            </div>

            <p style="font-size:13px;font-weight:600;color:#7a7a9a;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 8px">Next steps</p>
            <ol style="font-size:14px;line-height:1.9;color:#1a1a2e;padding-left:20px;margin:0 0 24px">
              <li>Forward the other email to everyone in your group</li>
              <li>Wait for all participants to complete the assessment</li>
              <li>Go to <a href="${url}" style="color:#0f1e36;font-weight:600">${url}</a> → "View report"</li>
              <li>Enter your private results code above to unlock the full report</li>
            </ol>

            <p style="font-size:13px;color:#7a7a9a;line-height:1.6;margin:0">
              The full report includes individual personality profiles, a compatibility matrix,
              team dynamics analysis, and a hyper-performance hiring brief for your next key hire.
            </p>
          </div>
          <p style="font-size:11px;color:#b0aaa0;text-align:center;margin:16px 0 0">
            PartnerIQ · Partnership Intelligence · <a href="${url}" style="color:#b0aaa0">${url}</a>
          </p>
        </div>
      `
    });
    return { sent: true };
  } catch (err) {
    console.error('Organiser private email failed:', err.message);
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
      // Send both emails — Email 1 (forward-ready team invite) + Email 2 (private codes)
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
      context: group.context || {},
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
      await sendGroupCodeEmail(email, grp.name, grp.group_code, process.env.APP_URL);
      await sendOrganiserPrivateEmail(email, grp.name, grp.group_code, grp.results_code, process.env.APP_URL);
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
