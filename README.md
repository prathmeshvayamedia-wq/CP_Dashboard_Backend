# CP Performance Backend — PropEdge

Scalable backend for managing Channel Partner (broker) performance across real estate projects.

---

## Architecture

```
cp-backend/
├── src/
│   ├── index.js                    ← Express app + server entry point
│   ├── config/
│   │   ├── supabase.js             ← Supabase client
│   │   └── logger.js               ← Winston logger
│   ├── routes/
│   │   └── index.js                ← All API routes
│   ├── services/
│   │   ├── classification.service.js  ← Core tier logic + scoring
│   │   ├── automation.service.js      ← Trigger engine + daily summary
│   │   ├── whatsapp.service.js        ← WhatsApp API (Meta/Interakt/Wati)
│   │   └── import.service.js          ← CSV import + validation
│   ├── jobs/
│   │   └── scheduler.js            ← All cron jobs
│   └── middleware/
│       └── auth.js                 ← JWT auth middleware
├── config/
│   └── schema.sql                  ← Supabase DB schema (run this first)
├── scripts/
│   ├── importCSV.js                ← CLI import tool
│   └── sample_cps.csv              ← Sample CSV template
└── .env.example                    ← All environment variables
```

---

## Setup (30 min)

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor → paste and run `config/schema.sql`
3. Copy your `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from Settings → API

### 2. WhatsApp (pick ONE provider)

**Option A — Meta Cloud API (recommended, free tier available)**
1. Go to [developers.facebook.com](https://developers.facebook.com) → Create App → Business
2. Add WhatsApp product → get `Phone Number ID` and `Access Token`
3. Register message templates in Meta Business Manager (see template names in `whatsapp.service.js`)
4. Set `WHATSAPP_PROVIDER=meta` in `.env`

**Option B — Interakt (easiest for India, ₹999/mo)**
1. Sign up at [interakt.ai](https://www.interakt.ai)
2. Connect your WhatsApp Business number
3. Get your API key from Settings
4. Set `WHATSAPP_PROVIDER=interakt`

**Option C — Wati (also popular in India)**
1. Sign up at [wati.io](https://www.wati.io)
2. Get API key and server URL
3. Set `WHATSAPP_PROVIDER=wati`

### 3. Install and run
```bash
git clone <repo>
cd cp-backend
npm install
cp .env.example .env
# Fill in .env values
npm run dev
```

---

## Tier Classification Logic

| Tier     | Monthly Criteria                         | Automated Action                             |
|----------|------------------------------------------|----------------------------------------------|
| Active   | ≥5 site visits AND ≥1 deal closed        | WhatsApp: perk/premium inventory access      |
| Dormant  | 1–4 visits OR 0 deals                    | WhatsApp: support + follow-up message        |
| Inactive | <1 visit AND 0 deals / 14+ days inactive | WhatsApp alert + meeting scheduled           |

All thresholds are **configurable per project** via `PATCH /api/projects/:id/tier-rules`.

---

## Automation Triggers

| Trigger                | When it fires                                  | Message sent to      |
|------------------------|------------------------------------------------|----------------------|
| `inactivity_7d`        | No activity for 7 days                         | CP                   |
| `inactivity_14d`       | No activity for 14 days                        | CP (stronger tone)   |
| `inactivity_meeting`   | No activity for 21+ days                       | CP + meeting created |
| `no_conversation`      | No talk with sales team for 10+ days           | CP                   |
| `performance_drop`     | Score drops 30%+ vs last period                | CP                   |
| `dormant_support`      | CP classified dormant (once per period)        | CP                   |
| `active_perk`          | CP classified active (once per period)         | CP                   |
| `daily_summary`        | Every evening 7pm                              | Admin + Sales Head   |

All triggers have **cooldown guards** so a CP never gets the same message twice in a period.

---

## Cron Jobs

| Job                    | Schedule            | What it does                              |
|------------------------|---------------------|-------------------------------------------|
| Daily classification   | 9:00 AM IST daily   | Classify all CPs + fire triggers          |
| Evening summary        | 7:00 PM IST daily   | Send daily summary to admin               |
| Hourly inactivity check| Every hour          | Catch newly 7-day-inactive CPs            |
| Weekly classification  | Monday 8:00 AM IST  | Weekly period re-classification           |
| Monthly classification | 1st of month 6AM    | Monthly reset + full re-classification    |

---

## API Reference

### Auth
```
POST /api/auth/login         { email, password } → { token, admin }
POST /api/auth/register      { name, email, password, whatsapp }
```

### Projects
```
GET    /api/projects                         → list all projects with CP counts
POST   /api/projects                         → create project
PATCH  /api/projects/:id                     → update project
GET    /api/projects/:id/tier-rules          → get tier thresholds
PATCH  /api/projects/:id/tier-rules          → update thresholds
```

### Channel Partners
```
GET    /api/projects/:pid/cps                → list CPs (filter: tier, period, search)
GET    /api/projects/:pid/cps/:cpId          → CP detail with activity + messages
PATCH  /api/projects/:pid/cps/:cpId/activity → manually update visits/deals
```

### Messaging
```
POST   /api/projects/:pid/cps/:cpId/message  → send manual WhatsApp to one CP
                                                Body: { text } or { triggerType }
POST   /api/projects/:pid/message-bulk       → bulk send to a tier
                                                Body: { tier, triggerType, text }
GET    /api/projects/:pid/messages           → message log with filter/pagination
```

### Meetings
```
POST   /api/projects/:pid/cps/:cpId/meetings → schedule meeting + notify CP
PATCH  /api/meetings/:id                     → update status (completed/cancelled)
```

### Import
```
POST   /api/projects/:pid/import             → upload CSV (multipart: file)
                                                Returns: { success, failed, errors }
```

### Analytics
```
GET    /api/projects/:pid/analytics          → tier stats, message stats, top CPs
GET    /api/projects/:pid/summaries          → daily summary history
```

### Automation
```
POST   /api/projects/:pid/run-automation     → manually trigger full automation run
```

### WhatsApp Webhook
```
GET    /api/webhook/whatsapp                 → Meta webhook verification
POST   /api/webhook/whatsapp                 → receive delivery receipts + CP replies
```

---

## CSV Import Format

Your CSV must have these columns (column names are flexible — see aliases in `import.service.js`):

| Column              | Required | Example                |
|---------------------|----------|------------------------|
| name                | ✅       | Rahul Mehta            |
| whatsapp            | ✅       | 9876543210             |
| email               |          | rahul@example.com      |
| firm_name           |          | Mehta Properties       |
| area                |          | Andheri West           |
| rera_number         |          | MH12345                |
| site_visits         |          | 12                     |
| client_referrals    |          | 3                      |
| deals_closed        |          | 1                      |
| last_active_at      |          | 2025-05-20             |
| last_conversation_at|          | 2025-05-18             |
| last_visit_at       |          | 2025-05-20             |

Download `scripts/sample_cps.csv` as your template.

---

## Scaling

This backend is ready to scale:
- **Supabase** handles up to 500MB free, then pay-per-use — supports millions of rows
- **Stateless API** — deploy multiple instances behind a load balancer (Railway, Render, AWS EC2)
- **Cron jobs** — run separately (`npm run jobs`) on a dedicated instance to avoid conflicts
- **WhatsApp rate limits** — Meta allows 1000 messages/day on free tier, unlimited on paid
- **Message cooldown guards** prevent spam if the server restarts or automation runs twice

---

## Deployment (Recommended: Railway)

```bash
# One-click deploy to Railway
railway init
railway up

# Set env vars
railway variables set SUPABASE_URL=... SUPABASE_SERVICE_KEY=... WHATSAPP_TOKEN=...
```

Or deploy to **Render**, **Heroku**, or any VPS running Node 18+.
