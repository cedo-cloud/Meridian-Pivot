# Solstice Check-In — Badge Check-In Kiosk

A working product site, ready to host as-is.

| Route            | Page |
|-------------------|------|
| `/`               | Home |
| `/kiosk`          | Check-In Kiosk (the live, working scanner) |
| `/badges`         | Attendee QR badge generation |
| `/how-it-works`   | Reliability / architecture explainer for visitors |
| `/legacy`         | Retired synchronous version, linked from How It Works only — not in nav |

## Run it

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

Open **http://127.0.0.1:8000**.

## What's not public, on purpose

`backend/static/day1.html` and `backend/static/day5.html` are still on disk but not routed by
`main.py` — they were the coursework-specific Blocker Journal and confidential Adaptability
Index. Neither belongs on a live product site (the Index especially — it's meant to stay
confidential), so they're excluded from routing rather than deleted, in case you still need them
for your own submission.

## Architecture notes (the technical story, for your own reference)

`/kiosk` publishes a print request to a queue and waits for a webhook confirmation before
showing "checked in" — instead of blocking on a synchronous vendor call. Each scan gets its own
job id; a webhook only advances state if it matches the attendee's *current* job, which is what
keeps duplicate scans and out-of-order confirmations from corrupting state. See `/how-it-works`
for the visitor-facing version of this explanation, and `main.py` for the implementation
(`pivot_process_webhook`, `pivot_start_checkin`).

`/legacy` is the earlier synchronous version this replaced — same 3 test attendees, its own
isolated state and API namespace (`/api/original/*`), not used by `/kiosk` in any way.

## QR badges

`/badges` renders a QR code per attendee (just their ID, e.g. `A-101`) generated
server-side. On `/day3` or `/day4`, click **SCAN VIA CAMERA** to scan one with a
webcam, or use the file-upload fallback to scan a photo of a printed badge — no
camera required. Manual buttons on each attendee card still work too, for quick
testing without a badge on hand.

- Click **SCAN QR BADGE** → attendee flips to `PRINTING…` immediately (this is the
  publish-to-queue step; nothing is confirmed yet).
- After a randomized 1.5–5s delay (simulating the vendor actually printing), a
  webhook fires and the card flips to `CHECKED IN` — or, ~15% of the time, to
  `PRINT FAILED` so you can see the recovery path (rescanning is allowed again).
- Click the same attendee's button again **while it's printing or already checked
  in** → a `409` is rejected in real time and logged in the queue panel. That's the
  duplicate-scan protection.
- The right-hand panel is a live log of every queue/webhook event, so you can watch
  jobs complete **out of order** if you scan two attendees close together — that's
  expected and handled correctly.

You can also poke the webhook directly to see the idempotency/staleness handling
that a real vendor retry would exercise:

```bash
curl -X POST localhost:8000/api/pivot/webhook/print-complete \
     -H 'Content-Type: application/json' \
     -d '{"job_id": "<copy from a scan response>", "attendee_id": "A-101", "status": "success"}'
```
Firing the same payload twice is a documented no-op the second time.

## Scope Delta Analysis

**Dropped**
- Synchronous, blocking call to the printer vendor's REST API. The kiosk no longer
  waits on an HTTP response before doing anything else.
- The old "success response → show Checked In" shortcut. There is now a real
  intermediate state (`pending`) the UI has to render honestly.

**Modified**
- Duplicate-scan protection: previously it only had to compare against a single
  synchronous outcome. Now it has to hold across a window of time where the
  attendee is neither checked in nor rejected — the `pending` state — and it has to
  survive confirmations arriving **out of order** relative to when badges were
  scanned. Implemented via a per-attendee `active_job_id` — a webhook only ever
  advances the state it was issued for, and can't be misapplied to a later job.
- The attendee state machine grew a state (`not_checked_in → pending → checked_in`,
  plus `print_failed` as a recovery branch) instead of a two-state
  not-checked-in/checked-in model.

**Added**
- A webhook endpoint (`POST /api/webhook/print-complete`) that didn't exist before —
  the kiosk now has to expose something to the outside world, not just call out.
- Idempotency handling for webhook retries (a resolved job ignores repeat
  confirmations) and staleness handling for a job that got superseded by a later
  scan (e.g. after a failed print + rescan).
- A `print_failed` recovery path. Not explicitly required by the pivot brief, but
  an async model without a failure path leaves attendees stuck in `pending`
  forever if the vendor ever reports back "failed" — so it was added to keep the
  state machine actually sound, not just complete on the happy path.

**Regression check**
- All three original acceptance behaviors still hold under the new model:
  attendee shows a result on screen, at least 3 attendees are supported, and a
  duplicate scan of an already-in-progress or already-checked-in attendee never
  produces a second print job.

## Design/implementation notes

- The "vendor" is simulated in-process (`vendor_worker` in `main.py`) rather than
  calling out over the network, so the demo is self-contained. It calls the exact
  same `process_webhook()` function the real HTTP route uses, so the idempotency
  and staleness logic is genuinely exercised, not just faked for the UI.
- Race protection on scanning uses a per-attendee `asyncio.Lock` — without it, two
  near-simultaneous scans of the same badge could both read "not checked in"
  before either write landed, and print two badges. That's the actual mechanism
  the duplicate-scan requirement is protecting against once things are async.
- State is in-memory (`dict`), matching the original prototype's scope — a real
  deployment would back this with a database, but that wasn't part of the pivot.
