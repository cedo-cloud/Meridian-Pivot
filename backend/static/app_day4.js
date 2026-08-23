const grid = document.getElementById("attendee-grid");
const logBody = document.getElementById("log-body");
const connDot = document.getElementById("conn-dot");
const connLabel = document.getElementById("conn-label");
document.getElementById("clear-log").addEventListener("click", () => (logBody.innerHTML = ""));

let attendees = {}; // id -> attendee object

const STATE_LABEL = {
  not_checked_in: "NOT CHECKED IN",
  pending: "PRINTING…",
  checked_in: "CHECKED IN",
  print_failed: "PRINT FAILED — RESCAN",
};

function cardHTML(a) {
  return `
    <article class="card state-${a.state}" id="card-${a.id}">
      <div class="card-id">${a.id}</div>
      <div class="card-name">${a.name}</div>
      <div class="printer-slot">
        <div class="badge-stub"></div>
        <span class="stamp stamp-ok">CHECKED IN</span>
        <span class="stamp stamp-fail">FAILED</span>
      </div>
      <div class="status-row">
        <span class="status-pill">${STATE_LABEL[a.state]}</span>
      </div>
      <button class="scan-btn" data-id="${a.id}">
        ${a.state === "not_checked_in" || a.state === "print_failed" ? "SCAN QR BADGE" : "SCAN AGAIN (test duplicate)"}
      </button>
      <div class="reject-msg" id="reject-${a.id}"></div>
    </article>
  `;
}

function renderAll() {
  grid.innerHTML = Object.values(attendees).map(cardHTML).join("");
  grid.querySelectorAll(".scan-btn").forEach((btn) => {
    btn.addEventListener("click", () => scan(btn.dataset.id));
  });
}

function renderOne(a) {
  const el = document.getElementById(`card-${a.id}`);
  if (!el) return renderAll();
  el.outerHTML = cardHTML(a);
  const btn = document.querySelector(`.scan-btn[data-id="${a.id}"]`);
  btn.addEventListener("click", () => scan(a.id));
}

async function loadAttendees() {
  const res = await fetch("/api/pivot/attendees");
  const list = await res.json();
  attendees = Object.fromEntries(list.map((a) => [a.id, a]));
  renderAll();
}

async function scan(id) {
  try {
    const res = await fetch(`/api/pivot/scan/${id}`, { method: "POST" });
    if (res.status === 409) {
      const body = await res.json();
      const btn = document.querySelector(`.scan-btn[data-id="${id}"]`);
      const msg = document.getElementById(`reject-${id}`);
      btn.classList.remove("flash-reject");
      void btn.offsetWidth; // restart animation
      btn.classList.add("flash-reject");
      msg.textContent = body.detail;
      setTimeout(() => (msg.textContent = ""), 3500);
      return;
    }
    const data = await res.json();
    attendees[id] = { ...attendees[id], state: data.state };
    renderOne(attendees[id]);
  } catch (e) {
    console.error("scan failed", e);
  }
}

function appendLog(entry) {
  const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  line.className = `log-line ev-${entry.type}`;
  line.innerHTML = `<span class="ts">${time}</span>  ${describe(entry)}`;
  logBody.appendChild(line);
  logBody.scrollTop = logBody.scrollHeight;
}

function describe(e) {
  const shortJob = e.job_id ? e.job_id.slice(0, 8) : "";
  switch (e.type) {
    case "print_job_queued":
      return `QUEUED    ${e.attendee_id} ${e.name}  job=${shortJob}`;
    case "vendor_printing_started":
      return `PRINTING  ${e.attendee_id}  job=${shortJob}`;
    case "checked_in":
      return `SUCCESS   ${e.attendee_id} ${e.name}  job=${shortJob}  webhook confirmed`;
    case "print_failed":
      return `FAILED    ${e.attendee_id} ${e.name}  job=${shortJob}`;
    case "duplicate_scan_rejected":
      return `REJECTED  ${e.attendee_id} ${e.name}  already ${e.current_state}`;
    case "webhook_ignored_duplicate":
      return `IGNORED   duplicate webhook delivery  job=${shortJob}`;
    case "webhook_ignored_stale_job":
      return `IGNORED   stale/superseded job  job=${shortJob}`;
    case "webhook_ignored_unknown_job":
    case "webhook_ignored_unknown_attendee":
    case "webhook_ignored_mismatch":
      return `IGNORED   malformed/unknown webhook  job=${shortJob}`;
    default:
      return JSON.stringify(e);
  }
}

function connectEvents() {
  const es = new EventSource("/api/pivot/events");
  es.onopen = () => {
    connDot.classList.add("live");
    connLabel.textContent = "live";
  };
  es.onerror = () => {
    connDot.classList.remove("live");
    connLabel.textContent = "reconnecting…";
  };
  es.onmessage = (msg) => {
    const entry = JSON.parse(msg.data);
    appendLog(entry);
    if (["checked_in", "print_failed"].includes(entry.type) && attendees[entry.attendee_id]) {
      attendees[entry.attendee_id].state = entry.type === "checked_in" ? "checked_in" : "print_failed";
      renderOne(attendees[entry.attendee_id]);
    }
    if (entry.type === "print_job_queued" && attendees[entry.attendee_id]) {
      attendees[entry.attendee_id].state = "pending";
      renderOne(attendees[entry.attendee_id]);
    }
  };
}

// QR camera / file scanning -> just call scan() with the decoded attendee id
initQrScanner("qr-panel", (decoded) => {
  if (attendees[decoded]) {
    scan(decoded);
  } else {
    const statusEl = document.querySelector("#qr-panel .qr-status");
    if (statusEl) statusEl.textContent = `Decoded "${decoded}" — not a known attendee ID.`;
  }
});

loadAttendees().then(connectEvents);
