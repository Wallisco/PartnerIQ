# PartnerIQ — Partnership Intelligence Assessment

A Big Five OCEAN personality + investment style assessment that reveals how a group thinks, invests, and works together. Built for founders, investors, and business partners evaluating co-founder or partnership fit.

## Features

- 20-question OCEAN personality assessment
- Group codes for multi-participant sessions
- Private results code (organiser-only access)
- AI-generated individual profiles, compatibility matrix, and team dynamics report
- Server-side Anthropic API calls (API key never exposed to browser)
- Persistent group data via JSON file store

---

## Deploy to Render from GitHub

### 1. Push to GitHub

```bash
cd partneriq-app
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/partneriq.git
git push -u origin main
```

### 2. Create a Render Web Service

1. Go to [render.com](https://render.com) and sign in
2. Click **New → Web Service**
3. Connect your GitHub repo (`partneriq`)
4. Render will auto-detect the `render.yaml` config
5. Set the environment variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your key from [console.anthropic.com](https://console.anthropic.com)
6. Click **Deploy**

Your app will be live at `https://partneriq.onrender.com` (or your custom name).

### 3. Custom domain (optional)

In Render dashboard → Settings → Custom Domains → add your domain.

---

## Local development

```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

npm install
npm start
# Open http://localhost:3000
```

---

## How it works

### User flows

**Create a group (organiser)**
1. Go to "Create a group"
2. Enter group name and your name
3. Get two codes:
   - **Group code** — share with all participants
   - **Results code** — keep private, used to unlock the full report

**Take the quiz (participants)**
1. Go to "Take the quiz"
2. Enter the group code
3. Complete 20 questions (~8 minutes)
4. See your personal OCEAN profile preview

**View the report (organiser only)**
1. Go to "View report"
2. Enter your private results code
3. Access four tabs:
   - **Summary** — executive compatibility verdict + radar chart
   - **Profiles** — individual AI-generated partner profiles
   - **Compatibility** — pairwise compatibility matrix with scores
   - **Team dynamics** — role fit, decision-making, conflict patterns, governance recommendations

### OCEAN framework

| Trait | What it measures in a partnership context |
|-------|------------------------------------------|
| Openness | Creative thinking, appetite for new ideas, adaptability |
| Conscientiousness | Execution reliability, structure, follow-through |
| Extraversion | Leadership energy, relationship-building, communication drive |
| Agreeableness | Collaboration vs assertiveness, conflict style, trust |
| Emotional Stability | Composure under pressure, risk tolerance, consistency |

---

## Architecture

```
partneriq-app/
├── server.js          # Express backend
├── public/
│   └── index.html     # Full frontend (single page app)
├── data/
│   └── groups.json    # Group data store (auto-created)
├── package.json
├── render.yaml        # Render deployment config
└── .env.example
```

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/groups` | Create a new group |
| GET | `/api/groups/:code` | Get group info (public) |
| POST | `/api/groups/:code/submit` | Submit quiz response |
| GET | `/api/results/:resultsCode` | Get full results (organiser) |
| POST | `/api/ai/analyse` | Proxy to Anthropic API |
| GET | `/health` | Health check |

---

## Roadmap

- [ ] PDF export of full report
- [ ] Email delivery of results code to organiser
- [ ] Payment gate before results code reveal (Stripe)
- [ ] Admin dashboard for multiple groups
- [ ] PostgreSQL data store for production scale

---

## Built with

- [Express](https://expressjs.com/) — backend
- [Anthropic Claude](https://anthropic.com/) — AI analysis
- [Chart.js](https://www.chartjs.org/) — radar charts
- [Render](https://render.com/) — hosting
