const $ = id => document.getElementById(id);

// Every part gets three scans, always in this order, saved under one shared
// correlation_id: the old 2D label, its new 2D replacement, then the 1D
// barcode on the harness's paper flag tag.
const STEPS = [
 { key: "old", label: "Old QR", badge: "Old", kind: "2d" },
 { key: "new", label: "New QR", badge: "New", kind: "2d" },
 { key: "barcode", label: "1D barcode", badge: "1D", kind: "1d" },
];
const STEP_BY_KEY = Object.fromEntries(STEPS.map(s => [s.key, s]));

const TABLE = "triple_scans";

// 2D codes look like P<EBOM>/<TRACEABILITY> (new labels, e.g. the Data
// Matrix P68744965AA/T015U162600613) or P<EBOM>-<TRACEABILITY> (old labels,
// e.g. P68579358AB-T05WH269300041). EBOM never contains a separator, so
// splitting on the first "/", "-" or whitespace after the leading "P"
// holds even if traceability itself contains one. No separator at all is
// accepted too, when traceability starts right after a standard 8-digit +
// 2-letter EBOM. Anything that doesn't match is still saved, just without
// parsed fields.
const QR_PATTERNS = [/^P([^-/\s]+)[-/\s]+(\S.*)$/, /^P(\d{8}[A-Z]{2})(T\S+)$/];

// The 1D barcode on the flag tag is Code 39 and holds the supplier serial
// printed under it (e.g. 5UCBMVYY04347) -- not the part number -- so it's
// saved as-is in raw_code, with nothing parsed out of it.

// 2D labels are Data Matrix (QR as a likely replacement); the flag tag is
// Code 39 -- the other common 1D symbologies are listed too so a tag from
// a different supplier still reads.
const SCAN_FORMATS = [
 Html5QrcodeSupportedFormats.DATA_MATRIX,
 Html5QrcodeSupportedFormats.QR_CODE,
 Html5QrcodeSupportedFormats.CODE_128,
 Html5QrcodeSupportedFormats.CODE_39,
 Html5QrcodeSupportedFormats.CODE_93,
 Html5QrcodeSupportedFormats.ITF,
 Html5QrcodeSupportedFormats.CODABAR,
];
const TWO_D_FORMATS = ["QR_CODE", "DATA_MATRIX", "AZTEC", "PDF_417", "MAXICODE"];

const PROJECT_KEY = "scan_reader3_project";
// Which projects are selectable is a hardcoded list here, on purpose --
// not read from the database at runtime. Every code must already exist as
// a row in the shared `projects` table (scan-code-reader1's
// migrations/004_projects_table.sql seeded WS, DT, WL, JL, JT, WD), which
// triple_scans.project references. With only one project listed, the
// selector is hidden.
const PROJECTS = ["WS"];
let currentProject = PROJECTS.includes(localStorage.getItem(PROJECT_KEY)) ? localStorage.getItem(PROJECT_KEY) : "WS";

let setId = null;   // correlation_id of the set being scanned right now
let setRows = [];   // rows already saved in that set, in step order -- its length is the current step index
let lastCompletedSet = null; // {id, rows} -- kept so Undo right after the 3rd scan can reopen the set
let pendingDecoded = null; // {raw, ebom, traceability, format}
let html5Qrcode = null;
let cameraRunning = false;
let torchOn = false;
let undoTimer = null;
let historyRows = [];
let linkTargetId = null;
let previewGeneration = 0; // guards the async duplicate check against a stale response landing after a newer scan

function esc(s) {
 return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function currentStep() {
 return STEPS[setRows.length];
}

function parseCode(raw, stepKey) {
 const text = raw.trim();
 if (STEP_BY_KEY[stepKey].kind === "1d") return { ebom: null, traceability: null };
 for (const pattern of QR_PATTERNS) {
  const m = pattern.exec(text);
  if (m) return { ebom: m[1], traceability: m[2].trim() };
 }
 return { ebom: null, traceability: null };
}

function formatTimestamp(iso) {
 return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

// ---- Project ----

$("project-select").innerHTML = PROJECTS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
$("project-select").value = currentProject;
$("project-bar").hidden = PROJECTS.length < 2;
$("btn-download-report-all").hidden = PROJECTS.length < 2; // same file as "Download report" with one project

$("project-select").addEventListener("change", () => {
 currentProject = $("project-select").value;
 localStorage.setItem(PROJECT_KEY, currentProject);
 // A scan sitting in the preview, or a half-finished set, was made with
 // one project in mind -- don't let a stray dropdown change split a set
 // across two projects. Anything already saved from it shows up under
 // "Waiting to be completed" in its own project.
 discardPreview();
 if (cameraRunning) stopCamera();
 resetSet();
 loadHistory($("search-input").value.trim());
 focusManualInput();
});

function getScanner() {
 if (!html5Qrcode) {
  html5Qrcode = new Html5Qrcode("reader-region", {
   formatsToSupport: SCAN_FORMATS,
   verbose: false,
   // The browser's native BarcodeDetector (Chrome on Android) reads 1D
   // barcodes far more reliably than the bundled ZXing decoder.
   experimentalFeatures: { useBarCodeDetectorIfSupported: true },
  });
 }
 return html5Qrcode;
}

// A handheld barcode scanner acts like a keyboard -- it just types the
// decoded text into whatever's focused, then Enter. Keeping this field
// focused by default (and re-focusing after every save/undo/discard) lets
// someone scan repeatedly without touching the screen between scans.
function focusManualInput() {
 $("manual-input").focus();
}

// ---- Set progress ----

function resetSet() {
 setId = crypto.randomUUID();
 setRows = [];
 updateProgressUI();
}

function updateProgressUI() {
 const index = setRows.length;
 document.querySelectorAll("#set-progress .step").forEach((el, i) => {
  el.classList.toggle("active", i === index);
  el.classList.toggle("done", i < index);
 });
 $("manual-input").placeholder = index === 2 ? "5UCBMVYY04347" : "P68744965AA/T015U162600613";
}

// ---- Camera ----

function pickBackCamera(cameras) {
 const back = cameras.find(c => /back|rear|environment/i.test(c.label));
 return (back || cameras[cameras.length - 1]).id;
}

function populateCameraSelect(cameras, selectedId) {
 const sel = $("camera-select");
 sel.innerHTML = cameras.map(c => `<option value="${esc(c.id)}">${esc(c.label || c.id)}</option>`).join("");
 sel.value = selectedId;
 sel.hidden = cameras.length < 2;
}

function showCameraError(err) {
 const el = $("camera-error");
 el.hidden = false;
 el.textContent = "Error: " + (err && err.message ? err.message : String(err));
}

function scanBox(viewfinderWidth, viewfinderHeight) {
 const side = Math.floor(Math.min(viewfinderWidth, viewfinderHeight, 260));
 return { width: side, height: side };
}

// The 2D labels read fine through html5-qrcode. The 1D step uses
// BarcodeReader instead (js/barcode-reader.js), which decodes at the
// camera's full resolution -- html5-qrcode's on-screen-size crop is too
// coarse for the flag tag's thin Code 39 bars.
let liveReader = null;

async function launchCamera(cameraId) {
 $("reader-region").hidden = false;
 if (currentStep().kind === "1d") {
  liveReader = await BarcodeReader.startLive($("reader-region"), cameraId, "1d", hit => {
   stopCamera();
   showPreview(hit.decodedText, hit.format);
  });
 } else {
  // Must be visible (real width/height) BEFORE start(): the library
  // measures this element's clientWidth up front to size the <video> it
  // inserts, and a still-hidden container measures as 0 -- which then
  // sticks as the video's inline width forever.
  await getScanner().start(cameraId, { fps: 10, qrbox: scanBox }, onDecoded, () => {});
 }
 cameraRunning = true;
 $("btn-start-camera").hidden = true;
 $("btn-stop-camera").hidden = false;
 updateTorchButton();
}

async function startCamera() {
 $("camera-error").hidden = true;
 try {
  const cameras = await Html5Qrcode.getCameras();
  if (!cameras || !cameras.length) throw new Error("No camera found on this device.");
  const preferredId = $("camera-select").value || pickBackCamera(cameras);
  populateCameraSelect(cameras, preferredId);
  await launchCamera(preferredId);
 } catch (err) {
  await stopCamera();
  showCameraError(err);
 }
}

async function stopCamera() {
 if (liveReader) {
  liveReader.stop();
  liveReader = null;
 } else if (html5Qrcode && cameraRunning) {
  try { await html5Qrcode.stop(); } catch (e) {}
  html5Qrcode.clear();
 }
 cameraRunning = false;
 torchOn = false;
 $("reader-region").hidden = true;
 $("btn-start-camera").hidden = false;
 $("btn-stop-camera").hidden = true;
 $("btn-torch").hidden = true;
}

function updateTorchButton() {
 const btn = $("btn-torch");
 try {
  btn.hidden = liveReader
   ? !liveReader.torchSupported
   : !html5Qrcode.getRunningTrackCameraCapabilities().torchFeature().isSupported();
  btn.textContent = torchOn ? "Torch: on" : "Torch: off";
 } catch (e) {
  btn.hidden = true;
 }
}

function formatOf(result) {
 try { return result.result.format.formatName || null; } catch (e) { return null; }
}

function onDecoded(decodedText, decodedResult) {
 stopCamera();
 showPreview(decodedText, formatOf(decodedResult));
}

$("btn-start-camera").addEventListener("click", startCamera);
$("btn-stop-camera").addEventListener("click", stopCamera);

$("btn-torch").addEventListener("click", async () => {
 try {
  torchOn = !torchOn;
  if (liveReader) await liveReader.setTorch(torchOn);
  else await html5Qrcode.getRunningTrackCameraCapabilities().torchFeature().apply(torchOn);
  updateTorchButton();
 } catch (e) {}
});

$("camera-select").addEventListener("change", async () => {
 if (cameraRunning) {
  await stopCamera();
  await launchCamera($("camera-select").value);
 }
});

$("file-input").addEventListener("change", async e => {
 const file = e.target.files[0];
 e.target.value = "";
 if (!file) return;
 $("camera-error").hidden = true;
 if (cameraRunning) await stopCamera();
 const kind = currentStep().kind;
 $("photo-status").hidden = false;
 try {
  let hit = null;
  // html5-qrcode is quick for a 2D label that fills the photo; anything
  // else gets the slower full-resolution pass over overlapping crops.
  if (kind === "2d") {
   try {
    const result = await getScanner().scanFileV2(file, false);
    hit = { decodedText: result.decodedText, format: formatOf(result) };
   } catch (e) {}
  }
  if (!hit) hit = await BarcodeReader.decodeImageFile(file, kind);
  showPreview(hit.decodedText, hit.format);
 } catch (err) {
  showCameraError(new Error(kind === "1d"
   ? "Couldn't read a 1D barcode in that photo. Get closer so the barcode fills more of the picture, keep it sharp, and try again."
   : "Couldn't find a recognizable code in that image."));
 } finally {
  $("photo-status").hidden = true;
 }
});

$("btn-manual-add").addEventListener("click", () => {
 const val = $("manual-input").value.trim();
 if (!val) return;
 showPreview(val, null);
 $("manual-input").value = "";
});
$("manual-input").addEventListener("keydown", e => {
 if (e.key === "Enter") $("btn-manual-add").click();
});

// ---- Preview / save ----

function discardPreview() {
 previewGeneration++;
 pendingDecoded = null;
 $("preview").hidden = true;
}

function showPreview(raw, format) {
 const step = currentStep();
 const { ebom, traceability } = parseCode(raw, step.key);
 pendingDecoded = { raw: raw.trim(), ebom, traceability };
 $("preview-step").textContent = `Scan ${setRows.length + 1} of 3 — ${step.label}`;
 $("preview-raw").textContent = pendingDecoded.raw;

 let fields;
 if (step.kind === "1d") {
  fields = `<div class="muted">Flag-tag barcode &mdash; saved as-is.</div>`;
 } else {
  fields = ebom
   ? `<div><span class="field-label">EBOM</span>${esc(ebom)}</div><div><span class="field-label">Traceability</span>${esc(traceability)}</div>`
   : `<div class="muted">Doesn't match the P+EBOM-Traceability pattern &mdash; will be saved as raw text only.</div>`;
 }
 // Only the camera/photo path knows the symbology; a handheld scanner
 // just types text. A mismatch is a hint, not a block -- labels may change.
 if (format) {
  const is2d = TWO_D_FORMATS.includes(format);
  if (is2d !== (step.kind === "2d")) {
   fields = `<div class="msg warn">This step expects ${step.kind === "1d" ? "the 1D barcode" : "a 2D (QR / Data Matrix) label"}, but a ${esc(format.replace(/_/g, " "))} code was read. Double-check it's the right label.</div>` + fields;
  }
 }
 $("preview-fields").innerHTML = fields;
 $("preview").hidden = false;
 runDuplicateCheck(pendingDecoded.raw);
}

function blockSave(html) {
 $("preview-fields").insertAdjacentHTML("afterbegin", `<div class="msg err">${html}</div>`);
 $("btn-save").disabled = true;
 $("btn-save").textContent = "Save";
}

function runDuplicateCheck(raw) {
 const generation = ++previewGeneration;
 // Same code as one already scanned in this set (e.g. the old QR scanned
 // again instead of the new one) -- caught locally, no round trip needed.
 const sameInSet = setRows.find(r => r.raw_code === raw);
 if (sameInSet) {
  blockSave(`This is the same code you just scanned as the ${esc(STEP_BY_KEY[sameInSet.label_version].label)} in this set &mdash; all three codes must be different. Discard and scan the ${esc(currentStep().label)}.`);
  return;
 }
 $("btn-save").disabled = true;
 $("btn-save").textContent = "Checking…";
 checkForDuplicate(raw, generation);
}

// The exact same code showing up twice anywhere -- any step, any set, any
// project -- means a label got scanned twice, since each physical label
// should only ever be scanned once. Checked against the database (not just
// this session), and it blocks Save outright (fails closed) rather than
// just warning -- Discard & rescan is the only way past it. EBOM matching
// across scans is normal (two units of the same part number), so the check
// is on the raw code, never on EBOM alone.
async function checkForDuplicate(raw, generation) {
 const { data, error } = await sbClient
  .from(TABLE)
  .select("project, label_version, scanned_at")
  .eq("raw_code", raw)
  .limit(1);
 if (generation !== previewGeneration) return; // a newer scan superseded this one -- ignore

 if (error) {
  blockSave(`Couldn't check for duplicates (${esc(error.message)}) &mdash; <button class="link-inline" data-retry-dup-check="${esc(raw)}">Retry</button>`);
  return;
 }

 if (data && data.length) {
  const existing = data[0];
  const was = STEP_BY_KEY[existing.label_version] ? STEP_BY_KEY[existing.label_version].label : existing.label_version;
  blockSave(`This exact code was already recorded (as ${esc(was)} under project ${esc(existing.project)}, ${esc(formatTimestamp(existing.scanned_at))}) &mdash; can't save a duplicate. Discard and scan the right label.`);
  return;
 }

 $("btn-save").disabled = false;
 $("btn-save").textContent = "Save";
}

$("preview-fields").addEventListener("click", e => {
 const btn = e.target.closest("button[data-retry-dup-check]");
 if (!btn) return;
 $("preview-fields").querySelectorAll(".msg.err").forEach(el => el.remove());
 runDuplicateCheck(btn.dataset.retryDupCheck);
});

$("btn-rescan").addEventListener("click", () => {
 discardPreview();
 focusManualInput();
});

let isSaving = false;

$("btn-save").addEventListener("click", async () => {
 // Checked and set synchronously, before anything else -- disabling the
 // button alone isn't a reliable enough guard against two click events
 // (e.g. a fast double-tap on a touchscreen) both slipping through before
 // the first request finishes and the DOM attribute visibly takes effect.
 if (!pendingDecoded || isSaving) return;
 isSaving = true;
 const row = {
  project: currentProject,
  correlation_id: setId,
  label_version: currentStep().key,
  raw_code: pendingDecoded.raw,
  ebom: pendingDecoded.ebom,
  traceability: pendingDecoded.traceability,
 };
 $("btn-save").disabled = true;
 const { data, error } = await sbClient.from(TABLE).insert(row).select().single();
 isSaving = false;
 $("btn-save").disabled = false;
 if (error) {
  showCameraError(new Error("Save failed: " + error.message));
  return;
 }
 $("camera-error").hidden = true;
 discardPreview();
 setRows.push(data);
 const completed = setRows.length === STEPS.length;
 showSavedToast(data, completed);
 if (completed) {
  lastCompletedSet = { id: setId, rows: setRows };
  resetSet();
 } else {
  lastCompletedSet = null;
  updateProgressUI();
 }
 loadHistory($("search-input").value.trim());
 focusManualInput();
});

function showSavedToast(row, completed) {
 clearTimeout(undoTimer);
 const toast = $("save-toast");
 toast.hidden = false;
 toast.innerHTML = `${completed ? "Set complete &mdash; saved " : "Saved "}${esc(STEP_BY_KEY[row.label_version].label)} <button id="btn-undo" class="link-btn">Undo</button>`;
 $("btn-undo").addEventListener("click", async () => {
  const { error } = await sbClient.from(TABLE).delete().eq("id", row.id);
  if (error) { alert("Undo failed: " + error.message); return; }
  toast.hidden = true;
  // Step back so the app asks for that same label again, instead of
  // moving on to a step whose predecessor no longer exists. If it was the
  // 3rd scan, the set just completed and was reset -- reopen it.
  if (setRows.length && setRows[setRows.length - 1].id === row.id) {
   setRows.pop();
  } else if (!setRows.length && lastCompletedSet && lastCompletedSet.rows.some(r => r.id === row.id)) {
   setId = lastCompletedSet.id;
   setRows = lastCompletedSet.rows.filter(r => r.id !== row.id);
  }
  lastCompletedSet = null;
  discardPreview();
  if (cameraRunning) stopCamera(); // its 1D/2D mode was picked for the step we just left
  updateProgressUI();
  loadHistory($("search-input").value.trim());
  focusManualInput();
 });
 undoTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

// ---- History / correlation ----

function groupByCorrelation(rows) {
 const groups = new Map();
 for (const row of rows) {
  if (!groups.has(row.correlation_id)) groups.set(row.correlation_id, []);
  groups.get(row.correlation_id).push(row);
 }
 return groups;
}

function rowFor(rows, key) {
 return rows.find(r => r.label_version === key);
}

function isComplete(rows) {
 return STEPS.every(s => rowFor(rows, s.key));
}

async function loadHistory(searchTerm) {
 let query = sbClient.from(TABLE).select("*").eq("project", currentProject).order("scanned_at", { ascending: false }).limit(300);
 if (searchTerm) {
  const like = `%${searchTerm}%`;
  query = query.or(`raw_code.ilike.${like},ebom.ilike.${like},traceability.ilike.${like}`);
 }
 const { data, error } = await query;
 if (error) {
  $("history-list").innerHTML = `<div class="msg err">${esc(error.message)}</div>`;
  return;
 }
 historyRows = data || [];
 renderHistory();
 renderIncomplete();
}

function renderHistory() {
 const groups = groupByCorrelation(historyRows);
 if (!groups.size) {
  $("history-list").innerHTML = '<div class="empty">No scans yet.</div>';
  return;
 }
 $("history-list").innerHTML = [...groups.values()].map(rows => {
  const complete = isComplete(rows);
  return `<div class="scan-group ${complete ? "complete" : ""}">
    <div class="group-status">${complete ? "&#10003; Complete" : `${rows.length} of 3`}</div>
    ${STEPS.map(s => renderScanLine(rowFor(rows, s.key), s)).join("")}
   </div>`;
 }).join("");
}

function renderScanLine(row, step) {
 if (!row) return `<div class="scan-line missing"><span class="badge badge-${step.key}">${step.badge}</span><span class="muted">missing</span></div>`;
 const sub = row.ebom ? `EBOM ${esc(row.ebom)} &middot; Trace ${esc(row.traceability)} &middot; ` : "";
 return `<div class="scan-line">
   <span class="badge badge-${step.key}">${step.badge}</span>
   <div class="scan-body">
    <div class="scan-raw">${esc(row.raw_code)}</div>
    <div class="scan-sub">${sub}${esc(formatTimestamp(row.scanned_at))}</div>
   </div>
  </div>`;
}

// Sets missing one or two of their three scans -- e.g. the app was closed
// mid-set, or a scan was undone after moving on. The set being scanned
// right now is left out; it's incomplete only because it's in progress.
function incompleteGroups() {
 return [...groupByCorrelation(historyRows).entries()]
  .filter(([id, rows]) => id !== setId && !isComplete(rows));
}

function renderIncomplete() {
 const groups = incompleteGroups();
 $("link-card").hidden = !groups.length;
 if (!groups.length) {
  $("unpaired-list").innerHTML = ""; // don't leave stale rows sitting in the DOM just because the card is hidden
  return;
 }
 $("unpaired-list").innerHTML = groups.map(([id, rows]) => {
  const missing = STEPS.filter(s => !rowFor(rows, s.key)).map(s => s.label).join(" + ");
  return `<div class="incomplete-set">
    ${STEPS.filter(s => rowFor(rows, s.key)).map(s => {
     const row = rowFor(rows, s.key);
     return `<div class="unpaired-row">
       <span class="badge badge-${s.key}">${s.badge}</span>
       <span class="scan-raw">${esc(row.raw_code)}</span>
       <button class="ghost" data-delete-id="${row.id}">Delete</button>
      </div>`;
    }).join("")}
    <div class="incomplete-foot">
     <span class="muted">Missing: ${esc(missing)}</span>
     <button class="ghost" data-link-group="${esc(id)}">Link&hellip;</button>
    </div>
   </div>`;
 }).join("");
}

$("unpaired-list").addEventListener("click", async e => {
 const del = e.target.closest("button[data-delete-id]");
 if (del) {
  const row = historyRows.find(r => String(r.id) === del.dataset.deleteId);
  if (!row || !confirm(`Delete this ${STEP_BY_KEY[row.label_version].label} scan permanently?\n\n${row.raw_code}`)) return;
  const { error } = await sbClient.from(TABLE).delete().eq("id", row.id);
  if (error) { alert("Delete failed: " + error.message); return; }
  loadHistory($("search-input").value.trim());
  return;
 }
 const link = e.target.closest("button[data-link-group]");
 if (link) openLinkModal(link.dataset.linkGroup);
});

function openLinkModal(groupId) {
 linkTargetId = groupId;
 const rows = groupByCorrelation(historyRows).get(groupId) || [];
 const have = STEPS.filter(s => rowFor(rows, s.key)).map(s => `${s.label} ${rowFor(rows, s.key).raw_code}`).join(", ");
 const missing = STEPS.filter(s => !rowFor(rows, s.key)).map(s => s.label).join(" + ");
 $("link-modal-target").textContent = `Completing the set with ${have}. Pick the scan(s) holding its ${missing}:`;
 $("link-search").value = "";
 renderLinkResults("");
 $("link-modal").hidden = false;
 $("link-search").focus();
}

// Candidates are other incomplete sets that only hold the steps this one
// is missing -- merging them can never put two scans in the same slot.
function renderLinkResults(term) {
 const groups = groupByCorrelation(historyRows);
 const targetRows = groups.get(linkTargetId) || [];
 const candidates = [];
 for (const [id, rows] of incompleteGroups()) {
  if (id === linkTargetId) continue;
  if (rows.some(r => rowFor(targetRows, r.label_version))) continue;
  const haystack = rows.map(r => `${r.raw_code} ${r.ebom || ""} ${r.traceability || ""}`).join(" ").toLowerCase();
  if (term && !haystack.includes(term.toLowerCase())) continue;
  candidates.push([id, rows]);
 }
 $("link-results").innerHTML = candidates.length
  ? candidates.map(([id, rows]) => `
    <div class="unpaired-row">
     <div class="scan-body">
      ${rows.map(r => `<div><span class="badge badge-${r.label_version}">${STEP_BY_KEY[r.label_version].badge}</span> <span class="scan-raw">${esc(r.raw_code)}</span></div>`).join("")}
      <div class="scan-time">${esc(formatTimestamp(rows[0].scanned_at))}</div>
     </div>
     <button class="primary" data-pick-group="${esc(id)}">Choose</button>
    </div>`).join("")
  : `<div class="empty">No incomplete scans that fit${term ? " that search" : ""}.</div>`;
}

$("link-search").addEventListener("input", e => renderLinkResults(e.target.value.trim()));
$("link-cancel").addEventListener("click", () => { $("link-modal").hidden = true; });

$("link-results").addEventListener("click", async e => {
 const btn = e.target.closest("button[data-pick-group]");
 if (!btn) return;
 const ids = (groupByCorrelation(historyRows).get(btn.dataset.pickGroup) || []).map(r => r.id);
 const { error } = await sbClient.from(TABLE).update({ correlation_id: linkTargetId }).in("id", ids);
 if (error) { alert("Link failed: " + error.message); return; }
 $("link-modal").hidden = true;
 loadHistory($("search-input").value.trim());
});

let searchDebounce;
$("search-input").addEventListener("input", e => {
 clearTimeout(searchDebounce);
 const term = e.target.value.trim();
 searchDebounce = setTimeout(() => loadHistory(term), 300);
});
$("btn-refresh").addEventListener("click", () => loadHistory($("search-input").value.trim()));

// ---- CSV report ----

function csvValue(v) {
 if (v == null) return "";
 const s = String(v);
 return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// One row per set (not per scan) -- old/new/1D side by side, so the report
// reads the same way the "Recent scans" list does.
function buildReportCsv(rows) {
 const header = [
  "project", "complete",
  "old_raw_code", "old_ebom", "old_traceability", "old_scanned_at",
  "new_raw_code", "new_ebom", "new_traceability", "new_scanned_at",
  "barcode_raw_code", "barcode_scanned_at",
  "correlation_id",
 ];
 const lines = [header.join(",")];
 for (const groupRows of groupByCorrelation(rows).values()) {
  const o = rowFor(groupRows, "old");
  const n = rowFor(groupRows, "new");
  const b = rowFor(groupRows, "barcode");
  lines.push([
   groupRows[0].project,
   isComplete(groupRows) ? "yes" : "no",
   o ? o.raw_code : "", o ? o.ebom : "", o ? o.traceability : "", o ? formatTimestamp(o.scanned_at) : "",
   n ? n.raw_code : "", n ? n.ebom : "", n ? n.traceability : "", n ? formatTimestamp(n.scanned_at) : "",
   b ? b.raw_code : "", b ? formatTimestamp(b.scanned_at) : "",
   groupRows[0].correlation_id,
  ].map(csvValue).join(","));
 }
 return lines.join("\r\n");
}

// Supabase's API caps rows per request (commonly 1000) regardless of how
// many actually match -- a plain .select() silently truncates once a
// project has scanned past that many rows. Paged with .range() instead,
// looping until a page comes back short of a full page, so the report
// always has everything, not just the first batch.
const REPORT_PAGE_SIZE = 1000;

// projectFilter null means every project -- used by "Download all".
async function fetchAllReportRows(searchTerm, projectFilter) {
 const rows = [];
 for (let from = 0; ; from += REPORT_PAGE_SIZE) {
  let query = sbClient.from(TABLE).select("*")
   .order("scanned_at", { ascending: false }).range(from, from + REPORT_PAGE_SIZE - 1);
  if (projectFilter) query = query.eq("project", projectFilter);
  if (searchTerm) {
   const like = `%${searchTerm}%`;
   query = query.or(`raw_code.ilike.${like},ebom.ilike.${like},traceability.ilike.${like}`);
  }
  const { data, error } = await query;
  if (error) return { data: null, error };
  rows.push(...(data || []));
  if (!data || data.length < REPORT_PAGE_SIZE) return { data: rows, error: null };
 }
}

async function downloadReport(projectFilter, filenameTag) {
 const buttons = [$("btn-download-report"), $("btn-download-report-all")];
 buttons.forEach(b => b.disabled = true);
 const searchTerm = $("search-input").value.trim();
 const { data, error } = await fetchAllReportRows(searchTerm, projectFilter);
 buttons.forEach(b => b.disabled = false);
 if (error) { alert("Couldn't build the report: " + error.message); return; }

 const csv = buildReportCsv(data || []);
 const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
 const url = URL.createObjectURL(blob);
 const a = document.createElement("a");
 a.href = url;
 a.download = `triple-scans-report-${filenameTag}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
 document.body.appendChild(a);
 a.click();
 a.remove();
 URL.revokeObjectURL(url);
}

$("btn-download-report").addEventListener("click", () => downloadReport(currentProject, currentProject));
$("btn-download-report-all").addEventListener("click", () => downloadReport(null, "ALL"));

// ---- Init ----
resetSet();
loadHistory();
focusManualInput();
