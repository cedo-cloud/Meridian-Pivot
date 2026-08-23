# Solstice Check-In — Badge Check-In Kiosk

A working conference badge check-in kiosk demonstrating an asynchronous print workflow using a message queue and webhook confirmation.

The application allows attendees to scan QR badges, submit print jobs, receive simulated printer confirmations, and handle duplicate scans, failed prints, webhook retries, and out-of-order confirmations.

## Features

- QR-code badge generation
- QR-code scanning through a webcam
- File-upload fallback for scanning badge images
- Manual attendee check-in for testing
- Asynchronous print-job processing
- Simulated vendor/print worker
- Webhook-based print confirmation
- Duplicate-scan protection
- Webhook idempotency
- Stale-job protection
- Print-failure recovery
- Live queue/event logging
- Legacy synchronous implementation for comparison

## Application Routes

| Route | Description |
|---|---|
| `/` | Home page |
| `/kiosk` | Check-in kiosk with QR scanner |
| `/badges` | Attendee QR badge generation |
| `/how-it-works` | Reliability and architecture explanation |
| `/legacy` | Retired synchronous implementation |

## Requirements

- Python 3.x
- FastAPI
- Uvicorn
- A modern web browser
- Webcam (optional — file upload can be used instead)

## Running the Application

Clone the repository and navigate to the backend directory:

```bash
cd backend
```

Install the required dependencies:

```bash
pip install -r requirements.txt
```

Start the application:

```bash
uvicorn main:app --reload
```

Open the application in your browser:

http://127.0.0.1:8000

## QR Badges

The `/badges` page generates a QR code for each attendee. Each QR code contains the attendee's ID, for example:

```text
A-101
```

On the kiosk, users can:

1. Click **SCAN VIA CAMERA** to scan a badge using a webcam.
2. Upload an image of a printed QR badge as an alternative.
3. Use the manual attendee buttons for testing.

### Check-In Workflow

When a badge is scanned:

```text
NOT CHECKED IN
       ↓
   Scan Badge
       ↓
    PRINTING
       ↓
  Print Job Queued
       ↓
Webhook Confirmation
       ↓
   CHECKED IN
```

If printing fails:

```text
PRINTING
    ↓
Print Failure
    ↓
PRINT FAILED
    ↓
Rescan Allowed
```

The simulated vendor introduces a randomized delay of approximately 1.5–5 seconds before sending a webhook confirmation. Some jobs may fail to demonstrate the recovery path.

## Duplicate Scan Protection

A second scan is rejected while an attendee is already being processed or has already been checked in.

For example:

```text
Scan A-101
     ↓
PRINTING
     ↓
Second scan of A-101
     ↓
409 Conflict
```

This prevents multiple print jobs from being created for the same attendee.

The implementation uses a per-attendee `asyncio.Lock` to prevent two nearly simultaneous scans from both reading the attendee as `not_checked_in` before either request updates the state.

## Asynchronous Architecture

The kiosk does not wait for a synchronous printer response before continuing.

Instead, the workflow is:

```text
QR Scanner
    |
    v
Kiosk API
    |
    v
Create Print Job
    |
    v
Message Queue
    |
    v
Vendor / Print Worker
    |
    v
Webhook Callback
    |
    v
Update Attendee Status
```

Each scan receives its own job ID.

The webhook only updates an attendee when the incoming job ID matches the attendee's current active job. This prevents an old or delayed webhook from incorrectly changing the state of a newer print job.

The main implementation can be found in `main.py`, particularly around:

- `pivot_start_checkin`
- `pivot_process_webhook`
- `vendor_worker`

## Webhook Testing

The webhook can also be tested manually.

Replace `<job_id>` with the job ID returned from a scan:

```bash
curl -X POST http://localhost:8000/api/pivot/webhook/print-complete \
     -H "Content-Type: application/json" \
     -d '{"job_id": "<job_id>", "attendee_id": "A-101", "status": "success"}'
```

Sending the same successful webhook payload more than once is handled safely. Once a job has already been resolved, subsequent confirmations do not create another state transition.

## State Management

The attendee state machine consists of:

```text
not_checked_in
       |
       v
    pending
     /   \
    /     \
   v       v
checked_in  print_failed
               |
               v
            Rescan
```

The `pending` state is important because the system no longer assumes that creating a print request means printing has successfully completed.

## Scope Delta Analysis

### Dropped

- Synchronous, blocking calls to the printer vendor's REST API.
- The previous "successful HTTP response = Checked In" behavior.
- Immediate confirmation of check-in before the print vendor has confirmed completion.

### Modified

#### Duplicate Scan Protection

The original implementation only needed to handle a synchronous outcome.

The asynchronous implementation must protect the attendee during the period between creating a print job and receiving the vendor confirmation.

This is handled using a per-attendee `active_job_id`.

A webhook only updates the state associated with the job that generated it. If a newer job has already replaced the old one, the stale webhook cannot modify the attendee's current state.

#### Attendee State Machine

The original two-state model was expanded to:

```text
not_checked_in → pending → checked_in
                         ↘
                           print_failed
```

This provides an explicit recovery path when printing fails.

### Added

#### Webhook Endpoint

The asynchronous architecture introduces a webhook endpoint:

```text
POST /api/pivot/webhook/print-complete
```

The kiosk therefore receives external confirmation rather than relying solely on an outgoing synchronous request.

#### Idempotency

Repeated webhook confirmations for an already-resolved job are safely ignored.

#### Stale Job Protection

If an attendee starts a new print job after a previous job fails, a delayed webhook from the old job cannot incorrectly complete the new job.

#### Print Failure Recovery

A `print_failed` state was added so that a failed print does not leave an attendee permanently stuck in the `pending` state.

## Regression Check

The original acceptance behaviors remain supported:

- An attendee receives a visible result on the kiosk.
- At least three attendees are supported.
- A duplicate scan of an attendee who is already processing or already checked in does not create another print job.

## Architecture and Implementation Notes

### Simulated Vendor

The printer vendor is simulated in-process using `vendor_worker` in `main.py`.

This keeps the demonstration self-contained while exercising the same webhook processing logic used by the actual HTTP webhook endpoint.

### Concurrency Protection

Scanning uses a per-attendee `asyncio.Lock`.

Without this protection, two nearly simultaneous scans could potentially:

1. Read the attendee as `not_checked_in`.
2. Both create print jobs.
3. Both update the attendee.

The lock ensures that the check-and-update operation is protected against this race condition.

### State Storage

The current prototype stores application state in memory using Python dictionaries.

This is appropriate for the scope of the prototype and demonstration.

For a production deployment, the state would typically be stored in a persistent database so that attendee and job information survives application restarts and can be shared across multiple application instances.

## Project Structure

```text
Meridian-Pivot/
│
├── README.md
│
└── backend/
    ├── main.py
    ├── requirements.txt
    │
    └── static/
        ├── app_day3.js
        ├── app_day4.js
        ├── badges.html
        ├── day1.html
        ├── day5.html
        ├── home.html
        ├── how-it-works.html
        ├── kiosk.html
        ├── legacy.html
        ├── nav.css
        ├── nav.js
        ├── qr-scanner.js
        └── styles.css
```

## Coursework Files

The following files remain in the project for coursework/submission purposes but are not exposed through the live product routes:

- `backend/static/day1.html`
- `backend/static/day5.html`

`day1.html` contains the Blocker Journal, while `day5.html` contains the Adaptability Index.

These materials are intentionally excluded from the public product navigation, particularly the Adaptability Index because it is intended to remain confidential.

## Technologies Used

- Python
- FastAPI
- Uvicorn
- HTML
- CSS
- JavaScript
- QR code generation and scanning
- Asynchronous processing
- Webhooks
- In-memory state management
