"""
SLA Monitoring — Supabase (Postgres) persistence.

Isolated from cleaning.py (no data-transformation logic here) and from main.py (no HTTP/
Flask concerns here) — this module's only job is turning a list of already-clean rows
into rows in the `checks` table, via Supabase's REST API.
"""

import os
import httpx

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
INSERT_CHUNK_SIZE = 500


def insert_batch(rows: list[dict]) -> None:
    """
    Writes cleaned rows to Supabase's `checks` table, in chunks, using the service-role
    key (server-side only, bypasses RLS). Duplicate rows (per the DB's unique index) are
    silently skipped rather than erroring, so re-uploading the same file is safe.

    Raises RuntimeError if credentials are missing or the write fails, with a message
    specific enough to act on directly.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY is not set in this process's "
            "environment — set both (or add a backend/.env file) and restart the "
            "server/function."
        )

    url = f"{SUPABASE_URL}/rest/v1/checks"
    params = {"on_conflict": "service_id,agent,ts,status_code,latency_ms_key"}
    headers = {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Prefer": "resolution=ignore-duplicates,return=minimal",
    }

    with httpx.Client(timeout=30.0) as client:
        for i in range(0, len(rows), INSERT_CHUNK_SIZE):
            chunk = rows[i:i + INSERT_CHUNK_SIZE]
            try:
                res = client.post(url, params=params, headers=headers, json=chunk)
            except httpx.HTTPError as err:
                raise RuntimeError(f"Could not reach Supabase at {url}: {err}") from err
            if res.status_code >= 300:
                raise RuntimeError(
                    f"Supabase insert failed ({res.status_code}): {res.text}"
                )
