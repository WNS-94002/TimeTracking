# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A no-login face-scan attendance app in Thai. A supervisor points a camera at an employee; the browser identifies
them locally (face-api.js) and posts the check-in/out to a Google Apps Script Web App, which upserts a row in a
Google Sheet and stores the snapshot in Google Drive. No build step, package manager, or test suite.

Same architecture and design system as the sibling project `../Evaluate Employee Program` — `style.css`,
`apiGet`/`apiPost`/`showError`, the `state.view` + `render()` dispatcher, and the header-name-based sheet helpers
in `Code.gs` were all lifted from there. Keep the two consistent; fixes to shared patterns usually belong in both.

## Commands

```bash
python -m http.server 8000     # then http://localhost:8000 — camera works on localhost
node --check app.js && node --check face.js
cp Code.gs /tmp/Code.gs.js && node --check /tmp/Code.gs.js   # must be renamed to .js first

node tests/test-face.js    # matching: threshold, margin, multi-angle, stabilizer
node tests/test-code.js    # time maths: lateness, work hours, dateKey_ normalization
```

The two test files cover **pure logic only** — no camera, no Google. They `eval()` the source and, for
`Code.gs`, stub `Utilities`/`Session` with just the `formatDate` patterns the logic actually calls. If you add a
new `Utilities.formatDate` format string in `Code.gs`, the stub throws until you add it there too — that is
deliberate, so the stub can't silently drift from reality.

Anything touching `SpreadsheetApp`, `DriveApp`, or `LockService` cannot be tested outside Apps Script. Backend
changes require pasting into the Apps Script editor, **Deploy > New deployment** (saving alone does not update
the live `/exec` URL), and exercising the live app.

## Two constraints that shaped the whole design

1. **The camera cannot run inside Apps Script.** HtmlService serves user HTML in a sandbox iframe without the
   `camera` permission, so `getUserMedia()` throws *"Permissions policy violation"* (Google bugs 486623612,
   486922850, no fix). That is why the frontend is static files on GitHub Pages and only the backend is Apps
   Script. Do not "simplify" this by moving `index.html` into `HtmlService` — the app stops working entirely.
2. **`getUserMedia()` needs a secure context** — `https://` or `http://localhost` only. Opening `index.html`
   via `file://` gives a working-looking page with a dead camera.

## Architecture

```
index.html ──> face.js  (face-api: models, camera, descriptors, matching — knows nothing about Sheets or app state)
           └─> app.js   (state machine, views, API calls — never touches face-api internals directly)
                  │ fetch
                  ▼
              Code.gs at /exec ──> Google Sheet (5 tabs) + Google Drive (photos)
```

- `app.js`'s `API_URL` must point at the deployed `/exec` URL; `API_TOKEN` must match `API_TOKEN` in `Code.gs`.
- **`apiPost()` deliberately sends no `Content-Type` header.** Apps Script cannot set CORS headers on a preflight
  response, so the POST must stay a "simple request". `doPost` parses `e.postData.contents` regardless of the
  declared type. Adding `Content-Type: application/json` breaks every POST.
- Views (`state.view`): `scan` (default), `dashboard`, `attendance`, `enroll`, `employees` / `employeeForm`,
  `settings`. Each has a `render*()` function; `render()` is the dispatcher.
- Every `doGet`/`doPost` branch returns `{ ok: true, data }` or `{ ok: false, error }`; `apiGet`/`apiPost` throw
  on `ok: false` and callers route the message through `showError()`.
- `doGet?action=bootstrap` bundles settings + employees + faces into one round trip. Apps Script responses are
  slow (~1s each); adding a fourth thing the first screen needs belongs in `bootstrap`, not a new request.

## Camera lifecycle

**The camera never opens on its own.** Both camera views render with a placeholder and an explicit button
("เริ่มสแกน" / "เปิดกล้อง"); `startScan()` and `startEnrollCamera()` only run from a click. Do not call them
from a `render*()` function — an attendance kiosk that grabs the webcam the moment the page loads is exactly
what the user asked us to stop doing.

`setView()` calls `stopScanLoop()` + `FaceEngine.stopCamera()` and clears `state.enroll.cameraOn` on **every**
view change. Any new view that opens the camera must be reachable only through `setView`, or the camera light
stays on after navigating away.

`state.scanning` / `state.enroll.cameraOn` drive the button labels and the enable state of "เก็บภาพ". Both are
reset by `setView`, so returning to a camera view always lands back on "press to start" — never auto-resuming.

**One press scans exactly one person.** `submitScan()` calls `stopScan({ keepResult: true })` *before* awaiting
the POST, not after: Apps Script takes ~1s to answer, and a camera left running through that window captures
whoever walks up next. Stopping first also means the result card is the only thing on screen while the write
lands, so the operator cannot mistake a stale preview for the new person. The card stays until the next
`startScan()`, which clears it.

The scan loop is guarded by the module-level `scanToken`: `stopScanLoop()` increments it, and each iteration
bails if its captured token no longer matches. `await` points inside the loop mean a view change can land
mid-iteration — that is exactly what the token check catches. Keep the check after every `await`.

## Face matching

- Library is **`@vladmandic/face-api`** (CDN), not the original `face-api.js` — the original stopped at 0.22.2 in
  2020 and is incompatible with modern TensorFlow.js.
- Weights are committed under `models/` and loaded from there, not from a CDN, so the page has exactly one origin
  to trust and cannot break when a CDN reshuffles versions. Nets used: `tinyFaceDetector`, `faceLandmark68Net`,
  `faceRecognitionNet`.
- A match requires **both** `distance < MatchThreshold` **and** `secondBest - best >= MatchMargin`, plus the same
  employee on 3 consecutive frames (`createStabilizer`). The margin rule is what stops similar-looking employees
  from being confused; if you loosen the threshold, do not also drop the margin.
- Enrollment writes **4 rows** per employee to `FaceData`: the average of the 3 samples plus each sample. Matching
  takes the minimum distance across all of a person's rows, so extra rows only help recall.
- `enrollFaces_` deletes the employee's old rows and writes the new ones **inside one request, under one lock**.
  Doing it as separate delete + insert calls left a window where a failure stranded the employee with a mix of
  old and new faces (or none at all), and cost ~5s of Apps Script round trips.

## Sheet <-> object mapping

Every tab is read/written by **header name**, not column position (`sheetToObjects_`, `objectToRow_`,
`findRowById_`, `getHeaders_`). Users can reorder columns freely; renaming a header on one side only makes that
field silently read/write blank. `setupSheets()` creates all 5 tabs and is the source of truth for headers
(`SHEET_HEADERS`).

Two readers exist and are not interchangeable:
- `sheetToObjects_` / `formatValue_` converts Dates to ISO strings — for data sent to the frontend.
- `rowObject_` returns **raw** cell values so Dates stay Dates — for anything that computes with times
  (`recordScan_`, `updateAttendance_`). Use `formatRow_` on the way back out.

`dateKey_()` normalizes a date cell to `yyyy-MM-dd` whether the sheet stored text or a real Date, so key matching
survives users retyping a date cell. Use it for every date comparison rather than comparing cells directly.

## recordScan_ behaviour worth knowing before changing it

- Wrapped in `LockService.getScriptLock()` — a kiosk can fire overlapping requests, and without the lock two
  scans read the same row and clobber each other.
- **The timestamp comes from the server, not the client.** A tablet with a wrong clock must not be able to write
  a wrong attendance time.
- `AUTO` resolves to IN when there is no `TimeIn` yet, otherwise OUT — *except* within `MinScanIntervalMinutes`
  of the check-in, where it is treated as a duplicate IN. Without that carve-out, scanning twice at 08:00 would
  record an OUT one minute after arriving.
- An explicit `IN` when `TimeIn` already exists never overwrites it: first arrival is the real arrival. Corrections
  go through the attendance view's manual edit (`updateAttendance_`), which recomputes late/hours.
- Photo upload failures are swallowed (logged to console) — the photo is supporting evidence, and losing it must
  not fail the time record.

## Where the Thai UI strings live

All user-facing text is Thai, inline in the render functions. `escapeHtml()` wraps every interpolated value —
employee names come from a user-edited spreadsheet, so treat all sheet data as untrusted when building HTML.
