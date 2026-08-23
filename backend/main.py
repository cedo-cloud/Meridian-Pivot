"""
Solstice Events Co. — Check-in Kiosk
=====================================
The Meridian Pivot simulation, Days 3-5, in one running app:

  /api/original/*   Day 3  — ORIGINAL SPEC. Synchronous vendor call.
                             DEPRECATED as of Day 4 — kept only so Day 5's
                             regression check / Scope Delta has something
                             real to diff against. Not used by the live app.

  /api/pivot/*       Day 4  — PIVOT SPEC (live). Async: publish to a queue,
                             wait for a webhook callback before showing
                             "Checked In". This is the system actually in use.

  /api/badges/*             QR badge generation, shared by both modules —
                             same physical badge, same attendee_id, routed
                             at whichever backend the page you're on talks to.

See README.md for the Scope Delta Analysis (Day 5) and instructions.
"""

import asyncio
import io
import json
import random
import time
import uuid
from collections import deque
from typing import Literal

import qrcode
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Solstice Check-in Kiosk — Meridian Pivot")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ATTENDEE_ROSTER = [
    {"id": "A-101", "name": "Jordan Ruiz"},
    {"id": "A-102", "name": "Priya Nandakumar"},
    {"id": "A-103", "name": "Sam O'Connell"},
]


def now_ms() -> int:
    return int(time.time() * 1000)


# ===========================================================================
# DAY 3 — ORIGINAL SPEC (DEPRECATED)
# ===========================================================================
# Client asked for: kiosk calls the vendor's REST API and BLOCKS until the
# print job's success response comes back. "Checked In" is only shown once
# that response has actually arrived.
#
# NON-NEGOTIABLE RULE this module exists to satisfy: obsolete pre-pivot code
# must be visibly marked deprecated, not silently left running in parallel
# with the new system. This whole module is that marker. `/day3` in the UI
# is explicitly labeled DEPRECATED and nothing in the Day 4 pivot imports
# from here.
# ---------------------------------------------------------------------------

original_attendees: dict[str, dict] = {
    a["id"]: {**a, "state": "not_checked_in"} for a in ATTENDEE_ROSTER
}
original_in_flight: set[str] = set()   # attendee_ids currently blocked on a sync vendor call
original_log: deque = deque(maxlen=100)
original_lock = asyncio.Lock()

ORIGINAL_FAIL_RATE = 0.15
ORIGINAL_MIN_DELAY, ORIGINAL_MAX_DELAY = 1.0, 2.5


def original_log_event(kind: str, **data):
    original_log.append({"type": kind, "ts": now_ms(), **data})


async def call_vendor_synchronously(attendee_id: str) -> bool:
    """
    Stand-in for: `requests.post(VENDOR_PRINT_URL, ...)` and blocking on
    the response. In the real (pre-pivot) system this was a literal
    synchronous HTTP call to the printer vendor. Success/fail is decided
    here and now — there is no callback, no queue, no later confirmation.
    """
    await asyncio.sleep(random.uniform(ORIGINAL_MIN_DELAY, ORIGINAL_MAX_DELAY))
    return random.random() >= ORIGINAL_FAIL_RATE


@app.get("/api/original/attendees")
async def original_list():
    return list(original_attendees.values())


@app.get("/api/original/log")
async def original_get_log():
    return list(original_log)


@app.post("/api/original/scan/{attendee_id}")
async def original_scan(attendee_id: str):
    if attendee_id not in original_attendees:
        raise HTTPException(status_code=404, detail="Unknown attendee")

    attendee = original_attendees[attendee_id]

    async with original_lock:
        if attendee["state"] == "checked_in":
            original_log_event("duplicate_rejected", attendee_id=attendee_id, name=attendee["name"], reason="already checked in")
            raise HTTPException(status_code=409, detail=f"{attendee['name']} is already checked in. No second badge will be printed.")
        if attendee_id in original_in_flight:
            original_log_event("duplicate_rejected", attendee_id=attendee_id, name=attendee["name"], reason="already printing")
            raise HTTPException(status_code=409, detail=f"{attendee['name']}'s badge is already being printed. Please wait.")
        original_in_flight.add(attendee_id)

    original_log_event("vendor_call_started", attendee_id=attendee_id, name=attendee["name"])

    try:
        # THE BLOCKING CALL — this is what the pivot eliminates. Nothing
        # else can happen for this request until the vendor responds.
        success = await call_vendor_synchronously(attendee_id)
    finally:
        original_in_flight.discard(attendee_id)

    if success:
        attendee["state"] = "checked_in"
        original_log_event("checked_in", attendee_id=attendee_id, name=attendee["name"])
        return {"attendee_id": attendee_id, "state": "checked_in"}
    else:
        original_log_event("vendor_call_failed", attendee_id=attendee_id, name=attendee["name"])
        raise HTTPException(status_code=502, detail=f"Vendor print API did not return success for {attendee['name']}. Scan again.")


# ===========================================================================
# DAY 4 — PIVOT SPEC (LIVE)
# ===========================================================================
# Vendor deprecated the synchronous print API. Kiosk now publishes a print
# request onto the vendor's message queue and exposes its own webhook to
# receive a callback once the job actually completes. See README for the
# full Scope Delta Analysis (what was dropped / modified / added).
# ---------------------------------------------------------------------------

pivot_attendees: dict[str, dict] = {
    a["id"]: {**a, "state": "not_checked_in", "active_job_id": None} for a in ATTENDEE_ROSTER
}
pivot_jobs: dict[str, dict] = {}
pivot_locks: dict[str, asyncio.Lock] = {a["id"]: asyncio.Lock() for a in ATTENDEE_ROSTER}
pivot_queue: asyncio.Queue = asyncio.Queue()
pivot_subscribers: list[asyncio.Queue] = []
pivot_event_log: deque = deque(maxlen=200)

PIVOT_FAIL_RATE = 0.15
PIVOT_MIN_DELAY, PIVOT_MAX_DELAY = 1.5, 5.0


async def pivot_publish(event_type: str, data: dict):
    entry = {"type": event_type, "ts": now_ms(), **data}
    pivot_event_log.append(entry)
    for q in pivot_subscribers:
        await q.put(entry)


async def pivot_start_checkin(attendee_id: str) -> dict:
    if attendee_id not in pivot_attendees:
        raise HTTPException(status_code=404, detail="Unknown attendee")

    lock = pivot_locks[attendee_id]
    async with lock:
        attendee = pivot_attendees[attendee_id]
        if attendee["state"] in ("pending", "checked_in"):
            await pivot_publish("duplicate_scan_rejected", {
                "attendee_id": attendee_id, "name": attendee["name"], "current_state": attendee["state"],
            })
            raise HTTPException(
                status_code=409,
                detail=f"{attendee['name']} is already {attendee['state'].replace('_', ' ')}. "
                       f"No second badge will be printed.",
            )

        job_id = str(uuid.uuid4())
        pivot_jobs[job_id] = {"job_id": job_id, "attendee_id": attendee_id, "status": "queued", "created_at": now_ms()}
        attendee["state"] = "pending"
        attendee["active_job_id"] = job_id

        await pivot_queue.put(job_id)
        await pivot_publish("print_job_queued", {"attendee_id": attendee_id, "name": attendee["name"], "job_id": job_id})
        return {"attendee_id": attendee_id, "state": "pending", "job_id": job_id}


class WebhookPayload(BaseModel):
    job_id: str
    attendee_id: str
    status: Literal["success", "failed"]


async def pivot_process_webhook(payload: WebhookPayload) -> dict:
    job = pivot_jobs.get(payload.job_id)
    if job is None:
        await pivot_publish("webhook_ignored_unknown_job", payload.model_dump())
        return {"ignored": True, "reason": "unknown job_id"}

    if job["attendee_id"] != payload.attendee_id:
        await pivot_publish("webhook_ignored_mismatch", payload.model_dump())
        return {"ignored": True, "reason": "attendee/job mismatch"}

    if job["status"] in ("success", "failed"):
        await pivot_publish("webhook_ignored_duplicate", payload.model_dump())
        return {"ignored": True, "reason": "job already resolved"}

    attendee = pivot_attendees.get(payload.attendee_id)
    if attendee is None:
        await pivot_publish("webhook_ignored_unknown_attendee", payload.model_dump())
        return {"ignored": True, "reason": "unknown attendee"}

    if attendee["active_job_id"] != payload.job_id:
        job["status"] = payload.status
        await pivot_publish("webhook_ignored_stale_job", payload.model_dump())
        return {"ignored": True, "reason": "job superseded by a newer scan"}

    job["status"] = payload.status
    if payload.status == "success":
        attendee["state"] = "checked_in"
        await pivot_publish("checked_in", {"attendee_id": attendee["id"], "name": attendee["name"], "job_id": payload.job_id})
    else:
        attendee["state"] = "print_failed"
        attendee["active_job_id"] = None
        await pivot_publish("print_failed", {"attendee_id": attendee["id"], "name": attendee["name"], "job_id": payload.job_id})

    return {"ignored": False}


async def pivot_vendor_worker():
    while True:
        job_id = await pivot_queue.get()
        asyncio.create_task(_pivot_process_one(job_id))


async def _pivot_process_one(job_id: str):
    job = pivot_jobs[job_id]
    await pivot_publish("vendor_printing_started", {"attendee_id": job["attendee_id"], "job_id": job_id})
    await asyncio.sleep(random.uniform(PIVOT_MIN_DELAY, PIVOT_MAX_DELAY))
    outcome: Literal["success", "failed"] = "failed" if random.random() < PIVOT_FAIL_RATE else "success"
    await pivot_process_webhook(WebhookPayload(job_id=job_id, attendee_id=job["attendee_id"], status=outcome))


@app.on_event("startup")
async def on_startup():
    asyncio.create_task(pivot_vendor_worker())


@app.get("/api/pivot/attendees")
async def pivot_list_attendees():
    return list(pivot_attendees.values())


@app.post("/api/pivot/scan/{attendee_id}")
async def pivot_scan(attendee_id: str):
    return await pivot_start_checkin(attendee_id)


@app.post("/api/pivot/webhook/print-complete")
async def pivot_webhook(payload: WebhookPayload):
    return await pivot_process_webhook(payload)


@app.get("/api/pivot/events")
async def pivot_sse(request: Request):
    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()
        pivot_subscribers.append(queue)
        try:
            for entry in list(pivot_event_log):
                yield f"data: {json.dumps(entry)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                entry = await queue.get()
                yield f"data: {json.dumps(entry)}\n\n"
        finally:
            pivot_subscribers.remove(queue)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ===========================================================================
# QR BADGES — shared by Day 3 and Day 4 (same physical badge, same ID)
# ===========================================================================

@app.get("/api/badges/{attendee_id}.png")
async def badge_qr(attendee_id: str):
    if attendee_id not in {a["id"] for a in ATTENDEE_ROSTER}:
        raise HTTPException(status_code=404, detail="Unknown attendee")
    img = qrcode.make(attendee_id, border=2, box_size=8)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.get("/api/roster")
async def roster():
    return ATTENDEE_ROSTER


# ===========================================================================
# Pages
# ===========================================================================

app.mount("/static", StaticFiles(directory="static"), name="static")

PAGES = {
    "/": "home.html",
    "/kiosk": "kiosk.html",
    "/badges": "badges.html",
    "/how-it-works": "how-it-works.html",
    "/legacy": "legacy.html",
}
for route, filename in PAGES.items():
    app.get(route)(lambda filename=filename: FileResponse(f"static/{filename}"))
