require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'groups.json');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Data helpers ──────────────────────────────────────────────────────────────
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

function readGroups() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function writeGroups(groups) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(groups, null, 2));
}

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

// ── Group API ─────────────────────────────────────────────────────────────────

// Create a new group
app.post('/api/groups', (req, res) => {
  const { name, organiser } = req.body;
  if (!name || !organiser) return res.status(400).json({ error: 'name and organiser required' });

  const groups = readGroups();
  let groupCode = genCode();
  while (groups[groupCode]) groupCode = genCode(); // ensure unique

  const resultsCode = genResultsCode(groupCode);
  groups[groupCode] = {
    name,
    organiser,
    groupCode,
    resultsCode,
    members: [],
    created: new Date().toISOString()
  };
  writeGroups(groups);
  res.json({ groupCode, resultsCode });
});

// Get group info by group code (public — no member data returned)
app.get('/api/groups/:code', (req, res) => {
  const groups = readGroups();
  const group = groups[req.params.code.toUpperCase()];
  if (!group) return res.status(404).json({ error: 'Group not found' });
  res.json({ name: group.name, organiser: group.organiser, memberCount: group.members.length });
});

// Submit quiz response
app.post('/api/groups/:code/submit', (req, res) => {
  const { name, roles, traits, archetype } = req.body;
  if (!name || !traits) return res.status(400).json({ error: 'name and traits required' });

  const groups = readGroups();
  const group = groups[req.params.code.toUpperCase()];
  if (!group) return res.status(404).json({ error: 'Group not found' });

  // Check for duplicate name
  const existing = group.members.findIndex(m => m.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0) {
    // Overwrite if same name retakes
    group.members[existing] = { name, roles: roles || [], traits, archetype, submitted: new Date().toISOString() };
  } else {
    group.members.push({ name, roles: roles || [], traits, archetype, submitted: new Date().toISOString() });
  }

  writeGroups(groups);
  res.json({ success: true, memberCount: group.members.length });
});

// Get full results (requires results code)
app.get('/api/results/:resultsCode', (req, res) => {
  const groups = readGroups();
  const group = Object.values(groups).find(g => g.resultsCode === req.params.resultsCode.toUpperCase());
  if (!group) return res.status(404).json({ error: 'Results code not found' });
  if (group.members.length === 0) return res.status(400).json({ error: 'No submissions yet' });
  res.json(group);
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
    });
    res.json({ result: message.content.map(b => b.text || '').join('') });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'AI analysis failed', detail: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Serve frontend for all other routes ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PartnerIQ running on port ${PORT}`);
  ensureDataDir();
});
