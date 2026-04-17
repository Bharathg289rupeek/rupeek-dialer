# Rupeek Lead Routing System — Step-by-Step Setup Guide

## Total Files: 44 | Backend: 16 | Dashboard: 13 | Config: 15

---

## PHASE 1: Local Development Setup

### Step 1 — Prerequisites

Install on your machine:
- **Node.js 20+**: https://nodejs.org
- **PostgreSQL 15+**: https://postgresql.org or use Docker
- **Git**: https://git-scm.com

### Step 2 — Initialize Repository

```bash
# Create repo
mkdir rupeek-dialer && cd rupeek-dialer
git init

# Copy all project files into this directory
# (the full file tree is provided in the zip)
```

### Step 3 — Install Dependencies

```bash
# Root (concurrently for dev)
npm install

# API
cd api && npm install && cd ..

# Dashboard
cd dashboard && npm install && cd ..
```

### Step 4 — Setup PostgreSQL

**Option A: Local Postgres**
```bash
# Create database
psql -U postgres -c "CREATE DATABASE rupeek_dialer;"
```

**Option B: Docker Postgres**
```bash
docker run -d --name rupeek-pg \
  -e POSTGRES_DB=rupeek_dialer \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:15-alpine
```

### Step 5 — Configure Environment

```bash
cd api
cp .env.example .env
# Edit .env with your values:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rupeek_dialer
#   JWT_SECRET=some-random-secret-string
#   ADMIN_EMAIL=admin@rupeek.com
#   ADMIN_PASSWORD=admin123
```

### Step 6 — Run Migrations & Seed

```bash
cd api

# Create all tables
npm run migrate

# Seed admin user + default routing rules
npm run seed
```

**What this creates:**
- 9 database tables (agents, leads, call_logs, retry_queue, etc.)
- 1 admin user (email/password from .env)
- 1 default routing config (9am-6pm, Mon-Sat, 20s ring)
- 3 source routing rules (chakra → branch, inbound → city, default → pincode)

### Step 7 — Start Development Servers

```bash
# From root directory — starts API on :3000 and Dashboard on :5173
npm run dev
```

**Or separately:**
```bash
# Terminal 1: API
cd api && npm run dev
# → http://localhost:3000

# Terminal 2: Dashboard
cd dashboard && npm run dev
# → http://localhost:5173 (proxies /api to :3000)
```

### Step 8 — Login to Dashboard

Open http://localhost:5173 and login with:
- Email: `admin@rupeek.com` (or whatever you set in .env)
- Password: `admin123`

---

## PHASE 2: Configure the System

### Step 9 — Upload Agents via CSV

1. Go to **Agents** page in dashboard
2. Click **Upload CSV**
3. Upload a CSV file with these columns:

```csv
branch_id,agent_email,agent_name,agent_phone,city,pincode,priority,city_identifier,pincode_identifier,branch_identifier
5cef5054f66878d97f357b0e,rajput@rupeek.com,Rajput Bachchansigh,9924325731,ahmedabad,560050,1,assign,dont assign,assign
5cef5177f66878d97f357b12,ekta@rupeek.com,Ekta Bhatt,9638884741,ahmedabad,560050,2,assign,dont assign,assign
```

**Key rules:**
- `agent_email` is the unique key — re-uploading updates existing agents
- If CSV has identifier columns with values → those are used
- If CSV has empty identifier columns → existing values are preserved
- Priority: 1 = P0 (called first), 2 = P1, 3 = P2

### Step 10 — Configure Source Routing Rules

1. Go to **Source Routing** page
2. For each lead source (chakra, inbound, website, etc.):
   - Set the **primary routing level** (pincode / branch_id / city)
   - Fallback chain is auto-generated from remaining levels
3. Use the **Test Routing** panel at the bottom:
   - Enter a sample lead source, city, pincode, branch_id
   - Click "Run Test" to see which agents would be matched

### Step 11 — Configure Global Settings

1. Go to **Global Settings** page
2. Set:
   - **Call center fallback number** (E.164 format: +91XXXXXXXXXX)
   - **Max parallel RMs** (default 3)
   - **Ring duration** (default 20 seconds)
   - **Business hours** (default 9:00 - 18:00 IST)
   - **Business days** (default Mon-Sat)
3. Click **Save Changes**

---

## PHASE 3: Exotel Integration

### Step 12 — Get Exotel Credentials

From your Exotel dashboard, collect:
- Account SID
- API Key
- API Token
- ExoPhone number(s)

Update `api/.env`:
```env
EXOTEL_ACCOUNT_SID=your_sid
EXOTEL_API_KEY=your_key
EXOTEL_API_TOKEN=your_token
EXOPHONE=0XXXXXXXXXX
```

### Step 13 — Configure Exotel Flow Builder (Outbound)

In Exotel's flow builder, create an outbound flow:

```
[Greeting Applet / TTS]
  → "You have a new gold loan lead. Please hold."
      ↓
[Passthru Applet]
  → URL: https://YOUR_DOMAIN/api/v1/exotel/passthru
  → Method: GET
  → On 200 → [Connect Applet]
  → On non-200 → [Hangup]
      ↓
[Connect Applet (Dynamic URL)]
  → URL: https://YOUR_DOMAIN/api/v1/exotel/connect
  → Method: GET
  → On "After conversation ends" → [End]
  → On "If nobody answers" → [Connect: Call Center Number]
```

Save the flow URL and update .env:
```env
EXOTEL_APP_URL=https://my.exotel.com/exoml/start/YOUR_FLOW_ID
```

### Step 14 — Configure Exotel Flow Builder (Inbound)

Create a separate inbound flow:

```
[Greeting: "Thank you for calling Rupeek..."]
      ↓
[Passthru]
  → URL: https://YOUR_DOMAIN/api/v1/exotel/inbound-passthru
  → On 200 → [Connect]
  → On non-200 → [Hangup]
      ↓
[Connect (Dynamic URL)]
  → URL: https://YOUR_DOMAIN/api/v1/exotel/inbound-connect
  → On "Nobody answers" → [Connect: Call Center]
```

Assign this flow to your ExoPhone in Exotel dashboard.

### Step 15 — Enable Parallel Ringing

Contact your Exotel TAM/Account Manager to enable the **Abix parallel ringing** feature on your account. This is required for dialing multiple RMs simultaneously.

---

## PHASE 4: Deploy to Railway

### Step 16 — Push to GitHub

```bash
git add -A
git commit -m "Initial commit: Rupeek Lead Routing System"
git remote add origin https://github.com/YOUR_ORG/rupeek-dialer.git
git push -u origin main
```

### Step 17 — Create Railway Project

1. Go to https://railway.app → New Project
2. Click **Deploy from GitHub Repo** → select `rupeek-dialer`
3. Railway auto-detects the Dockerfile

### Step 18 — Add PostgreSQL

1. In your Railway project → **+ New** → **Database** → **PostgreSQL**
2. Railway auto-creates the DB and sets `DATABASE_URL`
3. The `DATABASE_URL` variable is auto-linked to your service

### Step 19 — Set Environment Variables

In Railway → your service → **Variables** tab, add all variables from `.env.example`:

```
NODE_ENV=production
JWT_SECRET=generate-a-strong-random-string
ADMIN_EMAIL=admin@rupeek.com
ADMIN_PASSWORD=strong-password-here
EXOTEL_ACCOUNT_SID=your_sid
EXOTEL_API_KEY=your_key
EXOTEL_API_TOKEN=your_token
EXOPHONE=your_number
EXOTEL_APP_URL=https://my.exotel.com/exoml/start/flow_id
FALLBACK_CALL_CENTER_NUMBER=+91XXXXXXXXXX
API_BASE_URL=https://your-app.up.railway.app
```

**Note:** `DATABASE_URL` is auto-set by Railway when you link the Postgres service.

### Step 20 — Run Migrations on Railway

In Railway → your service → **Settings** → One-off command:

```bash
node api/src/db/migrate.js
```

Then run seed:
```bash
node api/src/db/seed.js
```

### Step 21 — Generate Public Domain

1. Railway → your service → **Settings** → **Networking**
2. Click **Generate Domain** → get something like `rupeek-dialer-production.up.railway.app`
3. Update `API_BASE_URL` env var with this domain
4. Update Exotel flow URLs to use this domain

### Step 22 — Verify Deployment

```bash
# Health check
curl https://YOUR_DOMAIN.up.railway.app/health
# → {"status":"ok","timestamp":"..."}

# Login
curl -X POST https://YOUR_DOMAIN.up.railway.app/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@rupeek.com","password":"your-password"}'
```

Open `https://YOUR_DOMAIN.up.railway.app` in browser → login → dashboard.

---

## PHASE 5: Connect Chakra CRM

### Step 23 — Configure Chakra Webhook

In Chakra CRM, set the lead creation webhook to:

```
POST https://YOUR_DOMAIN.up.railway.app/api/v1/leads/ingest
Content-Type: application/json

{
  "city": "${city}",
  "name": "${name}",
  "phone": "${phone_number}",
  "lead_id": "${lead_id}",
  "branch_id": "BR001",
  "loan_type": "${loan_type}",
  "lead_source": "chakra",
  "loan_amount": "${loan_amount}"
}
```

### Step 24 — Test End-to-End

1. Create a test lead in Chakra CRM
2. Watch the Dashboard → should show new lead
3. Check Call Logs → should show INITIATED → RM_CONNECTED or RM_NO_ANSWER
4. If RM doesn't answer → check Retry Queue → should show pending retry in 10 min
5. If all retries fail → lead should show as utm_created

---

## PHASE 6: UAT Checklist

Run through each scenario:

| # | Test | Expected |
|---|------|----------|
| 1 | Create lead during business hours | Call triggers immediately, RMs dialed |
| 2 | Create lead after 6pm | Lead queued, call at 9am next business day |
| 3 | Create lead on Sunday | Queued for Monday 9am |
| 4 | RM picks up, CX picks up | Status = connected, disposition = RM_CONNECTED |
| 5 | No RM answers | Retry in 10min, 3 attempts total, then UTM |
| 6 | RM picks, CX doesn't | Retry in 10min, 2 attempts total, then UTM |
| 7 | Customer calls ExoPhone | Inbound flow, parallel dials 3 RMs |
| 8 | Duplicate lead_id sent | Rejected with 409 if already connected |
| 9 | Upload CSV with new agents | New agents appear, old identifiers preserved |
| 10 | Change source routing rule | Test panel shows new routing path |
| 11 | Invalid phone number | Logged as CALL_FAILED, no retry |

---

## PHASE 7: Future — Migrate to AWS

When ready to move from Railway to AWS:

| Railway | AWS | Action |
|---------|-----|--------|
| Web Service | ECS Fargate | Same Docker image, push to ECR |
| PostgreSQL | RDS PostgreSQL | pg_dump from Railway → pg_restore to RDS |
| Env Vars | Parameter Store | Copy all env vars |
| Domain | ALB + Route53 | Point domain to ALB |
| Cron workers | pg-boss still works | Runs inside ECS task |

**No code changes needed.** Same Docker image, same env vars. Just different hosting.

```bash
# Export Railway DB
pg_dump $RAILWAY_DATABASE_URL > backup.sql

# Import to RDS
psql $AWS_RDS_URL < backup.sql
```

---

## File Reference (44 files)

```
rupeek-dialer/
├── .gitignore
├── Dockerfile                              # Multi-stage: build dashboard + run API
├── package.json                            # Root monorepo scripts
├── railway.toml                            # Railway deployment config
├── shared/
│   └── constants.js                        # Disposition codes, statuses
├── api/
│   ├── .env.example                        # All env vars documented
│   ├── package.json                        # Fastify, pg, pg-boss, etc.
│   └── src/
│       ├── server.js                       # Main entry — registers all routes + workers
│       ├── db/
│       │   ├── connection.js               # PG pool
│       │   ├── migrate.js                  # Migration runner
│       │   ├── seed.js                     # Seed admin + default config
│       │   └── migrations/
│       │       └── 001_initial.sql         # All 9 tables
│       ├── middleware/
│       │   └── auth.js                     # JWT + role middleware
│       ├── routes/
│       │   ├── auth.js                     # Login, /me
│       │   ├── leads.js                    # Ingest webhook + CRUD
│       │   ├── agents.js                   # CRUD + CSV upload
│       │   ├── exotel.js                   # Passthru, Connect, StatusCallback, Inbound
│       │   ├── source-routing.js           # Source routing rules CRUD + test
│       │   └── dashboard.js                # Stats, call logs, retry queue, routing config
│       ├── services/
│       │   ├── routing-engine.js           # Core RM selection — source-based routing
│       │   ├── call-orchestrator.js        # Exotel API calls
│       │   ├── retry-manager.js            # Retry scheduling + processing
│       │   ├── utm-creator.js              # UTM fallback lead creation
│       │   └── csv-processor.js            # CSV parse + upsert with identifier preservation
│       ├── workers/
│       │   └── index.js                    # pg-boss workers: retries + queue
│       └── utils/
│           └── business-hours.js           # IST time checks, phone formatting
└── dashboard/
    ├── index.html                          # Entry HTML with Google Fonts
    ├── package.json                        # React, Recharts, Lucide, Tailwind
    ├── vite.config.js                      # Vite + API proxy
    ├── tailwind.config.js                  # Custom colors, fonts
    ├── postcss.config.js
    └── src/
        ├── main.jsx                        # React root
        ├── index.css                       # Tailwind + component classes
        ├── App.jsx                         # Layout, sidebar, routes, auth context
        ├── hooks/
        │   └── api.js                      # Fetch wrapper with JWT
        └── pages/
            ├── Login.jsx                   # Auth screen
            ├── Dashboard.jsx               # Stats cards, hourly chart, dispositions
            ├── Leads.jsx                   # Lead list with filters, pagination
            ├── LeadDetail.jsx              # Single lead + call timeline
            ├── Agents.jsx                  # Agent table, CSV upload, inline toggles
            ├── SourceRouting.jsx           # Source routing rules + test panel
            ├── GlobalSettings.jsx          # Ring duration, hours, call center
            ├── CallLogs.jsx                # Call log table with filters
            └── RetryQueue.jsx              # Pending retries, trigger, cancel
```

---

## Quick Reference: API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/v1/auth/login | No | Login |
| GET | /api/v1/auth/me | Yes | Current user |
| **POST** | **/api/v1/leads/ingest** | **No** | **Chakra webhook** |
| GET | /api/v1/leads | Yes | List leads |
| GET | /api/v1/leads/:id | Yes | Lead detail |
| GET | /api/v1/agents | Yes | List agents |
| POST | /api/v1/agents | Yes | Create agent |
| PUT | /api/v1/agents/:id | Yes | Update agent |
| POST | /api/v1/agents/upload-csv | Yes | CSV upload |
| GET | /api/v1/agents/filters | Yes | Filter options |
| GET | /api/v1/source-routing-rules | Yes | List rules |
| POST | /api/v1/source-routing-rules | Yes | Create rule |
| PUT | /api/v1/source-routing-rules/:id | Yes | Update rule |
| DELETE | /api/v1/source-routing-rules/:id | Yes | Delete rule |
| POST | /api/v1/source-routing-rules/test | Yes | Test routing |
| GET | /api/v1/routing-config | Yes | Global config |
| PUT | /api/v1/routing-config/:id | Yes | Update config |
| GET | /api/v1/call-logs | Yes | Call logs |
| GET | /api/v1/dashboard/stats | Yes | Dashboard stats |
| GET | /api/v1/retry-queue | Yes | Retry queue |
| POST | /api/v1/retry-queue/:id/trigger | Yes | Manual retry |
| DELETE | /api/v1/retry-queue/:id | Yes | Cancel retry |
| ALL | /api/v1/exotel/passthru | No | Exotel passthru |
| ALL | /api/v1/exotel/connect | No | Exotel connect URL |
| POST | /api/v1/exotel/status-callback | No | Exotel callback |
| ALL | /api/v1/exotel/inbound-passthru | No | Inbound passthru |
| ALL | /api/v1/exotel/inbound-connect | No | Inbound connect |
| GET | /health | No | Health check |
