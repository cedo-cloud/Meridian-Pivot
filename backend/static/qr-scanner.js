/**
 * Thin wrapper around html5-qrcode so each kiosk page just needs to call
 * initQrScanner(containerId, onDecoded) and get a working camera scanner
 * plus an "upload a badge image" fallback for machines with no webcam.
 */
function initQrScanner(containerId, onDecoded) {
  const container = document.getElementById(containerId);
  let scanner = null;
  let running = false;

  const toggleBtn = container.querySelector(".qr-toggle");
  const readerDiv = container.querySelector(".qr-reader");
  const fileInput = container.querySelector(".qr-file-input");
  const statusEl = container.querySelector(".qr-status");

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  async function start() {
    if (running) return;
    if (typeof Html5Qrcode === "undefined") {
      setStatus("Camera scanner library failed to load — use the badge buttons below, or the file upload instead.");
      return;
    }
    scanner = new Html5Qrcode(readerDiv.id);
    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          onDecoded(decodedText.trim());
        },
        () => {} // per-frame decode failures — ignore, expected while framing the QR
      );
      running = true;
      toggleBtn.textContent = "STOP CAMERA";
      setStatus("Point a badge QR code at the camera.");
    } catch (err) {
      setStatus("Couldn't access a camera (permissions denied or none available). Use the file upload or badge buttons below.");
    }
  }

  async function stop() {
    if (!running || !scanner) return;
    try {
      await scanner.stop();
      scanner.clear();
    } catch (e) { /* ignore */ }
    running = false;
    toggleBtn.textContent = "SCAN VIA CAMERA";
    setStatus("");
  }

  toggleBtn.addEventListener("click", () => (running ? stop() : start()));

  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const tempScanner = new Html5Qrcode(readerDiv.id, /* verbose= */ false);
      try {
        const result = await tempScanner.scanFile(file, false);
        onDecoded(result.trim());
        setStatus(`Decoded badge from image: ${result.trim()}`);
      } catch (err) {
        setStatus("Couldn't read a QR code from that image. Try another photo, or use the badge buttons below.");
      } finally {
        fileInput.value = "";
      }
    });
  }
}
