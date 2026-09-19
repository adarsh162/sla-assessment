# SLA Monitoring Dashboard

## 1. Architecture: what runs where, and why

```
┌─────────────┐     raw CSV      ┌──────────────────┐     cleaned rows   ┌──────────────┐
│  Upload UI  │ ───────────────► │  Google Cloud     │ ─────────────────► │  Postgres    │
│  (React,    │                  │  Function          │   (service-role    │  (Supabase)  │
│  Vite)      │                  │  (Python, 2nd gen) │    REST insert)    │              │
└─────────────┘                  └──────────────────┘                     └──────┬───────┘
                                                                                   │
┌─────────────┐                                                                   │
│  Dashboard  │ ◄─────────────────────── read-only (anon key, RLS SELECT-only) ───┘
│  (React)    │
└─────────────┘
```

- **Upload UI + Dashboard — React (JavaScript) on Vite.** Two routes (`/` and `/dashboard`)
  via `react-router-dom`, built as a static site. No server-side rendering is needed since
  all data access happens client-side against Supabase directly (reads) or the backend
  (writes) — a static build keeps hosting simple and free-tier friendly.
- **Ingest — Python Google Cloud Function (2nd gen).** This is the "stateless processing"
  step the assignment calls out explicitly, and it's a literal Cloud Function, not an
  adjacent product standing in for one. It's built on `functions_framework` — Google's own
  required framework for deploying a Python Cloud Function — rather than a separate web
  framework like FastAPI: Cloud Functions expects one HTTP entry point per function, and
  since this service only needs one endpoint, `functions_framework`'s Flask-based
  request/response handling already covers everything a routing framework would add, so
  adding FastAPI on top would be unnecessary layering rather than a real requirement. It
  holds no state between invocations — every request starts from nothing but its body and
  two environment variables (Supabase URL + service-role key), set at deploy time.
- **The function's code is split into three files**, not left as one large script:
  `cleaning.py` holds all CSV parsing/validation logic with zero network or database
  dependency, which makes it directly testable on its own (it was run and verified
  against the real sample data independently of any live server or credentials);
  `db.py` holds the Supabase persistence logic, isolated from the cleaning rules;
  `main.py` is a thin HTTP wrapper — the `functions_framework` entry point, CORS, and
  response formatting — that just wires the other two together. This separation was a
  deliberate choice, not a requirement of Cloud Functions itself.
- **Persistence — Supabase Postgres.** Free tier, real Postgres (not just a REST wrapper),
  and it gives the dashboard a read-only client (anon key + Row Level Security limited to
  `SELECT`) without needing a second backend just to serve reads. The Cloud Function writes
  with the service-role key (via Supabase's REST API over `httpx`), which bypasses RLS —
  that key lives only in the function's environment and never reaches the browser.
- **Stats aggregation runs in the database, not the browser.** `service_stats()` is a SQL
  function using `percentile_cont` for p95 latency. Pulling every row to the client to compute
  that in JavaScript would work at this dataset's size, but would fall over as soon as a
  service accumulated weeks of 15-minute checks — aggregating in Postgres is the only version
  of this that stays fast as data grows, so I did it that way from the start rather than
  retrofitting it later.

## 2. Data findings

I did not use `dataset_incident_log.json` to write any of this logic — that file is clearly a
verification/answer-key artifact for the assignment's own test generation, not something the
app should read. Everything below was found by actually looking at the CSV. I validated my
cleaning logic against that file afterward, purely as a sanity check (it correctly surfaces a
dense cluster of 502/503s for `svc-reports` on the exact day/window the log describes).

Issues found in `monitoring_checks_9d_seed101.csv` (4,672 raw rows):

| Issue | Count | How it's handled |
|---|---|---|
| Mixed latency units (`ms` and `s` in the same column) | 4,672 rows split across both | Normalized to milliseconds everywhere before storage |
| Missing latency value (empty string) | 56 rows | Kept the row, `latency_ms` stored as `null` — excluded from latency averages/percentiles automatically, but still counted for availability |
| Negative latency (`-286ms`) | 1 row | Treated as invalid data, not a real reading — row kept, latency stored as `null` |
| Timestamp as raw Unix epoch seconds (no separators, e.g. `1746938700`) instead of ISO 8601 | 70 rows | Detected and parsed as epoch seconds, converted to UTC |
| Timestamp with an explicit offset (e.g. `+05:30`) instead of `Z`/UTC | 32 rows | Parsed and converted to UTC — mixing local-offset and UTC timestamps in one column would silently corrupt any time-based grouping otherwise |
| Sentinel status code `999` (not a real HTTP status) | 1 row | Treated as a failed check, same as a 5xx — an agent that couldn't get any real response is not a "success," and silently dropping it would understate downtime |
| Duplicate readings (same service/agent/status/latency at the same real moment) | 7 pairs (14 rows) | De-duplicated — see note below, this isn't just a byte-for-byte check |
| Real error status codes (500/502/503) | 45 rows total | Not a data-quality issue — this is the actual downtime signal the SLA math is built on |

**On duplicates specifically:** a naive byte-for-byte duplicate check on the raw file only
finds 6 pairs. There's a 7th: one row has `timestamp = 2025-05-09T20:00:00+05:30` and another
has `timestamp = 2025-05-09T14:30:00Z` — different strings, but `+05:30` on `20:00` is the
*same UTC instant* as `14:30Z`. Same service, same agent, same status, same latency. A
string-level dedup misses this entirely; catching it requires de-duplicating on the
*normalized* timestamp, which is what this pipeline does — timestamps are converted to UTC
before the de-dupe key is built, not after.

Two things I deliberately did **not** "fix": I didn't impute missing latency values (guessing a
number would misrepresent a real gap in the data as a real reading), and I didn't drop the
negative-latency row's status code along with its latency (a bad latency reading doesn't mean
the health check itself is invalid — the row is kept, only the untrustworthy number is nulled).

## 3. Assumptions

- **What counts as "down" for the uptime %:** any row where `status_code >= 500`, or the `999`
  sentinel. `4xx` codes don't appear in this dataset at all, but if they had, I would *not*
  have counted them as downtime by default — a 4xx is typically a client/request problem, not
  evidence the service itself was unavailable. This is exactly the kind of judgment call the
  assignment says is part of the exercise, so it's worth being explicit that it's a choice, not
  a fact derived from the data.
- **Duplicate detection key:** `service_id + agent + normalized_UTC_timestamp + status_code +
  latency`, not just `service_id + timestamp`. Two different agents legitimately checking the
  same service at the same timestamp is two real readings, not a duplicate — the key has to
  include `agent` or real multi-region monitoring data would get silently collapsed. And, per
  the finding above, the timestamp used in the key is the *normalized* one, not the raw string.
- **Stats shown (`service_stats` panel):** total checks, error count, uptime % against a 99.9%
  SLA target (with a visible breach flag when a service falls under it), average latency, and
  p95 latency. I picked these because they answer the two questions the assignment's own
  framing implies someone would actually have open this dashboard for: *"is this service
  currently breaching its SLA"* (billing/support) and *"how bad, and how slow, was it"*
  (on-call engineer triaging). I left out things like per-agent or per-region breakdowns, since
  this dataset only has one region and two agents — that dimension would matter more with a
  richer dataset, but here it would just be clutter.
- **Date filter scope:** filtering by date affects the stats panel and the logs table
  together, using the same window, on purpose — so a person can never see a stat that
  disagrees with the rows currently visible below it.
- **"End of day" for the "To" date filter:** inclusive through 23:59:59 of the selected day
  (implemented as `< next day 00:00:00`), since a person picking a single end date almost
  certainly means "through the end of that day," not "up to midnight at its start."
- **Not built, on purpose:** authentication/user accounts, multi-tenant support, and CI
  pipelines — all explicitly out of scope per the assignment brief.

## 4. Live URL, and how to run / redeploy

**Live URL:** https://sla-dashboard-puce.vercel.app/

**Supabase URL:** https://supabase.com/dashboard/project/tmjcuoivwcrhavzyuevz

**Python Cloud Function URL:** https://console.cloud.google.com/run/detail/us-central1/sla-ingest/observability/metrics?project=sla-assessment

### One-time setup

**Step 1 — Supabase (database)**
1. Create a free project at supabase.com.
2. Open the SQL editor and run the contents of `schema.sql` in this repo.
3. Under Project Settings → API, copy the **Project URL**, the **anon public key**, and the
   **service_role key** (keep the service-role key secret — it goes on the backend, never in
   the web app).

**Step 2 — Backend (Python Cloud Function on GCP)**

Requires a free Google Cloud account with billing enabled (Cloud Functions requires a
linked payment method even to use the free tier) and the `gcloud` CLI installed and
authenticated (`gcloud auth login`, then `gcloud config set project YOUR_PROJECT_ID`).

```bash
cd backend
gcloud functions deploy sla-ingest \
  --gen2 \
  --runtime=python312 \
  --region=us-central1 \
  --source=. \
  --entry-point=ingest \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars=SUPABASE_URL=https://YOUR_PROJECT.supabase.co,SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```
This deploys `main.py`'s `ingest` function (which imports `cleaning.py` and `db.py` from
the same directory — no extra configuration needed for the multi-file layout) as a real
Cloud Function, and prints its live URL, e.g.
`https://us-central1-YOUR_PROJECT.cloudfunctions.net/sla-ingest`. Cloud Functions' free
tier covers 2 million invocations/month — comfortably enough for this assignment.

**Step 3 — Web app (React, upload UI + dashboard)**
```bash
cd web
cp .env.local.example .env.local
# fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_API_URL (the Cloud Function URL from step 2)
```
Deploy by connecting this repo to Vercel or Netlify (either has a free tier for static
sites) and setting the same three variables in the project's environment variables. Both
auto-detect a Vite app and run `npm run build` → serve `dist/`.

### Running locally
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env    # fill in real SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
functions-framework --target=ingest --port=8080
```
The `.env` file is loaded automatically at startup (via `python-dotenv`, in `db.py`) —
no manual `export` needed, and it works the same regardless of which terminal you launch
the server from.

```bash
cd web
npm install
npm run dev     # http://localhost:5173
```

### Redeploying
Re-run the `gcloud functions deploy` command in `backend/` for the ingest function;
pushing to the connected branch redeploys the web app automatically on Vercel/Netlify.

## 5. What I'd do differently with more time

- **Streaming/chunked upload.** Right now the whole CSV is read into memory and inserted in
  fixed-size batches. That's fine at this file's size, but a genuinely huge CSV (say, a year
  of 15-minute checks across dozens of services) would want true streaming so the backend's
  memory footprint doesn't scale with file size.
- **Surfacing the cleaning report in the UI, not just the API response.** The backend returns a
  full list of what it fixed or dropped, but the upload page only shows a summary count. A
  small expandable "what we found" panel listing every issue (like the table in section 2,
  but generated live from that upload) would make the cleaning step's work visible instead of
  implicit.
- **A written incident view, not just raw error rows.** The logs table shows every individual
  failed check, but doesn't group consecutive failures into a single "this was one incident
  from 16:00-18:00" the way a human would describe it. That's a real feature, not just polish
  — it's the difference between a support person reading 8 separate error rows and reading
  "one 2-hour outage."
- **Alerting on the ingest response**, e.g. a Slack webhook when a batch's error rate or
  dropped-row count crosses a threshold, so a bad upload doesn't just sit unnoticed until
  someone happens to open the dashboard.
- **Rate limiting / basic abuse protection on the ingest endpoint.** It's deployed with
  `--allow-unauthenticated` (required, since the browser calls it directly with no backend
  of its own in front), which means anyone with the URL can currently POST arbitrary data
  to it with no limit. For this assignment's scope that's an acceptable tradeoff, but a
  production version would want either a lightweight shared-secret header the frontend
  attaches, or Cloud Armor / a per-IP rate limit in front of the function, so a bad actor
  (or just a buggy retry loop) can't spam writes into the database or run up invocation
  costs.