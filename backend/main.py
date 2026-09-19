"""
SLA Monitoring — ingest Cloud Function.

This is the "stateless processing" step the assignment requires, deployed as a real
Google Cloud Function (2nd gen, Python). It receives the raw CSV upload, parses + cleans
+ validates it, and writes the result directly to Postgres (via Supabase's REST API).
It holds no state between invocations — every request starts from nothing but the
request body and two environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY),
which is what makes it safe to run as a scale-to-zero function.

This uses `functions_framework` directly rather than a separate web framework like
FastAPI — functions_framework is itself the required framework for deploying a Python
Cloud Function (Cloud Functions won't run a bare ASGI app), and this service only needs
one HTTP entry point, so adding a full routing framework on top would be unnecessary
layering rather than a real requirement.

Run locally:    functions-framework --target=ingest --port=8080
Deploy:         see README "Deployment" section (gcloud functions deploy, 2nd gen)
"""

import json
import uuid

import functions_framework
from flask import Request

from cleaning import clean_rows
from db import insert_batch

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _json_response(body: dict, status: int):
    return (
        json.dumps(body),
        status,
        {"Content-Type": "application/json", **CORS_HEADERS},
    )


@functions_framework.http
def _handle_ingest(request: Request):
    """
    Single HTTP entry point for this Cloud Function. Handles CORS preflight, a GET
    health check (useful for confirming the function is reachable), and the real
    POST /ingest work — Cloud Functions route everything for a deployed function to
    this one handler, there's no separate router the way a full web framework gives you.
    """
    if request.method == "OPTIONS":
        return ("", 204, CORS_HEADERS)

    if request.method == "GET":
        return _json_response({"status": "ok"}, 200)

    if request.method != "POST":
        return _json_response({"error": "POST a CSV file body to this endpoint."}, 405)

    csv_text = request.get_data(as_text=True)
    if not csv_text or not csv_text.strip():
        return _json_response({"error": "Empty upload."}, 400)

    try:
        result = clean_rows(csv_text)
    except ValueError as err:
        return _json_response({"error": f"Parse failed: {err}"}, 400)

    if not result["rows"]:
        return _json_response(
            {"error": "No valid rows after cleaning.", "issues": result["issues"]}, 422
        )

    batch_id = str(uuid.uuid4())
    for row in result["rows"]:
        row["upload_batch"] = batch_id

    try:
        insert_batch(result["rows"])
    except RuntimeError as err:
        return _json_response({"error": str(err)}, 502)
    return _json_response(
        {
            "upload_batch": batch_id,
            "raw_row_count": result["raw_row_count"],
            "inserted_count": len(result["rows"]),
            "dropped_count": result["dropped_count"],
            "issue_count": len(result["issues"]),
            # capped so a genuinely messy file doesn't blow up the response
            "sample_issues": result["issues"][:50],
        },
        200,
    )
