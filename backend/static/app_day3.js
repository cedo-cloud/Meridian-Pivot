const grid = document.getElementById("attendee-grid");
const logBody = document.getElementById("log-body");
document.getElementById("clear-log").addEventListener("click", () => (logBody.innerHTML = ""));

let attendees = {};
let inFlight = new Set(); // client-side mirror so the button can show "waiting on vendor…"

const STATE_LABEL = {
  not_checked_in: "NOT CHECKED IN",
  checked_in: "CHECKED IN",
};

function cardHTML(a) {
  const waiting = inFlight.has(a.id);
  const label = waiting ? "WAITING ON VENDOR…" : STATE_LABEL[a.state];
  return `
    <article class="card ${waiting ? "state-pending" : "state-" + a.state}" id="card-${a.id}">
      <div class="card-id">${a.id}</div>
      <div class="card-name">${a.name}</div>
      <div class="printer-slot">
        <div class="badge-stub"></div>
        <span class="stamp stamp-ok">CHECKED IN</span>
      </div>
      <div class="status-row"><span class="status-pill">${label}</span></div>
      <button class="scan-btn" data-id="${a.id}" ${waiting ? "disabled" : ""}>
        ${a.state === "checked_in" ? "SCAN AGAIN (test duplicate)" : "SCAN QR BADGE"}
      </button>
      <div class="reject-msg" id="reject-${a.id}"></div>
    </article>
  `;
}

function renderAll() {
  grid.innerHTML = Object.values(attendees).map(cardHTML).join("");
  wireButtons();
}

function wireButtons() {
  grid.querySelectorAll(".scan-btn").forEach((btn) => {
    btn.addEventListener("click", () => scan(btn.dataset.id));
  });
}

async function loadAttendees() {
  const res = await fetch("/api/original/attendees");
  const list = await res.json();
  attendees = Object.fromEntries(list.map((a) => [a.id, a]));
  renderAll();
  refreshLog();
}

async function scan(id) {
  const msg = document.getElementById(`reject-${id}`);
  if (msg) msg.textContent = "";
  inFlight.add(id);
  renderAll();

  try {
    const res = await fetch(`/api/original/scan/${id}`, { method: "POST" });
    inFlight.delete(id);

    if (res.status === 409 || res.status === 502) {
      const body = await res.json();
      renderAll();
      const m = document.getElementById(`reject-${id}`);
      const btn = document.querySelector(`.scan-btn[data-id="${id}"]`);
      btn.classList.add("flash-reject");
      m.textContent = body.detail;
      setTimeout(() => (m.textContent = ""), 3500);
      refreshLog();
      return;
    }

    const data = await res.json();
    attendees[id] = { ...attendees[id], state: data.state };
    renderAll();
    refreshLog();
  } catch (e) {
    inFlight.delete(id);
    renderAll();
    console.error(e);
  }
}

async function refreshLog() {
  const res = await fetch("/api/original/log");
  const entries = await res.json();
  logBody.innerHTML = "";
  entries.forEach(appendLog);
  logBody.scrollTop = logBody.scrollHeight;
}

function appendLog(entry) {
  const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  const cls = entry.type === "checked_in" ? "ev-checked_in"
    : entry.type === "duplicate_rejected" ? "ev-duplicate_scan_rejected"
    : entry.type === "vendor_call_failed" ? "ev-print_failed"
    : "";
  line.className = `log-line ${cls}`;
  line.textContent = `${time}  ${describe(entry)}`;
  logBody.appendChild(line);
}

function describe(e) {
  switch (e.type) {
    case "vendor_call_started": return `CALLING VENDOR  ${e.attendee_id} ${e.name}  (blocking...)`;
    case "checked_in": return `SUCCESS   ${e.attendee_id} ${e.name}  vendor responded 200`;
    case "vendor_call_failed": return `FAILED    ${e.attendee_id} ${e.name}  vendor did not return success`;
    case "duplicate_rejected": return `REJECTED  ${e.attendee_id} ${e.name}  ${e.reason}`;
    default: return JSON.stringify(e);
  }
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

loadAttendees();
setInterval(refreshLog, 4000);
