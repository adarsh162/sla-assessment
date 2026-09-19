"""
SLA Monitoring — CSV parsing and cleaning logic.

Deliberately has no network or database dependency: everything here is pure data
transformation, which makes it directly testable (e.g. against a real sample CSV) without
needing a live server, Supabase credentials, or any mocking.
"""

import csv
import io
from datetime import datetime, timezone
from typing import Optional

REQUIRED_COLUMNS = [
    "service_id",
    "service_name",
    "timestamp",
    "status_code",
    "latency",
    "latency_unit",
    "agent",
    "region",
]


def is_error_status(code: int) -> bool:
    """
    A status code counts as a failed check if it's a real 5xx, OR the 999 sentinel this
    dataset uses for a check that didn't get a real HTTP response at all (agent-side
    timeout/error, not a server response).
    """
    return code >= 500 or code == 999


def parse_timestamp(raw: str) -> Optional[str]:
    """Returns an ISO 8601 UTC string, or None if unparseable."""
    trimmed = raw.strip()
    if not trimmed:
        return None

    # Case 1: pure unix epoch seconds, e.g. "1746938700" — no separators at all.
    if trimmed.isdigit():
        try:
            dt = datetime.fromtimestamp(int(trimmed), tz=timezone.utc)
            return dt.isoformat().replace("+00:00", "Z")
        except (ValueError, OverflowError, OSError):
            return None

    # Case 2: ISO 8601, either "...Z" or with an explicit offset like "+05:30".
    try:
        normalized = trimmed.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt_utc = dt.astimezone(timezone.utc)
        return dt_utc.isoformat().replace("+00:00", "Z")
    except ValueError:
        return None

def clean_rows(csv_text: str) -> dict:
    """
    Parses raw CSV text and returns cleaned, validated rows ready for insertion.

    Returns:
        {"rows": [...], "issues": [...], "dropped_count": int, "raw_row_count": int}

    Raises:
        ValueError: if the file is empty or missing a required column.
    """
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        raise ValueError("Empty file")

    header, data_rows = rows[0], rows[1:]
    col_index = {name.strip(): i for i, name in enumerate(header)}

    for col in REQUIRED_COLUMNS:
        if col not in col_index:
            raise ValueError(f"Missing required column: {col}")

    clean: list[dict] = []
    issues: list[dict] = []
    dropped_count = 0

    def get(cols: list[str], name: str) -> str:
        idx = col_index[name]
        return cols[idx].strip() if idx < len(cols) else ""

    for i, cols in enumerate(data_rows):
        line_no = i + 2  # +1 for header, +1 for 1-indexing
        row_issues: list[str] = []

        service_id = get(cols, "service_id")
        service_name = get(cols, "service_name")
        agent = get(cols, "agent")
        region = get(cols, "region")

        if not service_id or not agent or not region:
            issues.append(
                {"line": line_no, "issues": ["missing required field(s) — row dropped"]}
            )
            dropped_count += 1
            continue

        ts = parse_timestamp(get(cols, "timestamp"))
        if not ts:
            issues.append(
                {"line": line_no, "issues": ["unparseable timestamp — row dropped"]}
            )
            dropped_count += 1
            continue

        status_raw = get(cols, "status_code")
        try:
            status_code = int(status_raw)
        except ValueError:
            issues.append(
                {
                    "line": line_no,
                    "issues": [f'unparseable status_code "{status_raw}" — row dropped'],
                }
            )
            dropped_count += 1
            continue

        clean.append(
            {
                "service_id": service_id,
                "service_name": service_name,
                "ts": ts,
                "status_code": status_code,
                "agent": agent,
                "region": region,
                "is_error": is_error_status(status_code),
            }
        )
        if row_issues:
            issues.append({"line": line_no, "issues": row_issues})

    return {
        "rows": clean,
        "issues": issues,
        "dropped_count": dropped_count,
        "raw_row_count": len(data_rows),
    }
