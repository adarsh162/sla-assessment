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
import logging
import sys
import uuid

import functions_framework
from flask import Request

from cleaning import clean_rows
from db import insert_batch

logger = logging.getLogger("sla-ingest")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _handler = logging.StreamHandler(sys.stdout)
    _handler.setLevel(logging.INFO)
    _handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logger.addHandler(_handler)
logger.propagate = False  # don't also send it up to root, which could double-log it

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
def ingest(request: Request):
    """
    Entry point Cloud Functions actually calls. Wraps _handle_ingest in a catch-all so
    an unexpected exception returns a clear JSON error instead of functions_framework's
    generic HTML 500 page — that page hides the real cause and sends you hunting through
    server logs for something a one-line message could have told you immediately.
    """
    try:
        return _handle_ingest(request)
    except Exception as err:
        logger.exception("Unhandled error in ingest")
        return _json_response({"error": f"Unhandled error: {err}"}, 500)


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
        logger.warning("Received empty upload")
        return _json_response({"error": "Empty upload."}, 400)

    logger.info("Received upload: %d bytes", len(csv_text))

    try:
        result = clean_rows(csv_text)
    except ValueError as err:
        logger.warning("Parse failed: %s", err)
        return _json_response({"error": f"Parse failed: {err}"}, 400)

    if not result["rows"]:
        logger.warning("No valid rows after cleaning (%d raw rows)", result["raw_row_count"])
        return _json_response(
            {"error": "No valid rows after cleaning.", "issues": result["issues"]}, 422
        )

    batch_id = str(uuid.uuid4())
    for row in result["rows"]:
        row["upload_batch"] = batch_id

    logger.info(
        "Cleaned batch %s: %d raw -> %d inserted, %d dropped, %d issues",
        batch_id, result["raw_row_count"], len(result["rows"]),
        result["dropped_count"], len(result["issues"]),
    )

    try:
        insert_batch(result["rows"])
    except RuntimeError as err:
        logger.error("Insert failed for batch %s: %s", batch_id, err)
        return _json_response({"error": str(err)}, 502)

    logger.info("Batch %s inserted successfully", batch_id)

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
