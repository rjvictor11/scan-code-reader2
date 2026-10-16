# Triple Label Scanner

A camera-based scanner for wire-harness labels. Every part gets three
scans, always in this order:

1. **Old QR** — the old-format 2D label (Data Matrix / QR)
2. **New QR** — its new-format 2D replacement
3. **1D barcode** — the Code 39 barcode on the harness's paper flag tag
   (e.g. `5UCBMVYY04347`)

All three save to Supabase, timestamped, under a shared `correlation_id`.
It's the three-code follow-up to
[scan-code-reader1](https://github.com/rjvictor11/scan-code-reader1) and
works the same way: plain HTML/CSS/JS, no build step, no npm.

## How it reads labels

2D labels are split into EBOM and traceability. The new Data Matrix
encodes `P<EBOM>/<Traceability>`, e.g. `P68744965AA/T015U162600613`. The
old format, `P<EBOM>-<Traceability>`, and a space separator are accepted
too (`QR_PATTERNS` in `js/app.js`). Anything that doesn't match is still
saved in full, just without the parsed fields.

The 1D barcode is the supplier serial printed under it (e.g.
`5UCBMVYY04347`), not the part number, so it's saved as-is in `raw_code`.

The camera tries Data Matrix, QR, Code 128, Code 39, Code 93, ITF, and
Codabar (`SCAN_FORMATS`). On the 1D step the scan box turns wide and
short so the whole barcode fits. On Chrome for Android the browser's
built-in barcode detector is used, which reads 1D codes much better. If
the camera reads a 2D code on the 1D step (or the other way around),
the preview shows a warning. It doesn't block Save.

## Checks before Save

Save stays disabled when:

- **The code is the same as one already scanned in this set.** For
  example, the old QR got scanned again instead of the new one. All three
  codes in a set must be different.
- **The exact code is already recorded**, in any set, under any step,
  under any project. A physical label should only be scanned once. This
  is checked against the database live. If the check itself fails (for
  example, a network hiccup), it fails closed: Save stays blocked and a
  Retry button shows.

Two parts sharing an EBOM is normal, so the check is on the full raw code,
never on EBOM alone. The 1D barcode is a per-harness serial, so repeat
part numbers don't trip it.

## Interrupted sets

If a set is left unfinished (the app was closed mid-set, or a scan was
undone after moving on), it shows in **Waiting to be completed**, with
what's missing. **Link…** completes it from another incomplete set that
holds only the missing scans. **Delete** removes one scan permanently.
**Undo** (8 seconds after each save) removes that scan and asks for it
again, even if it was the third scan that just completed the set.

## Projects

This version is **WS only**. With a single project, the Project selector
and **Download all** are hidden, and every scan saves under `WS`.

To add another project later, add its code to the `PROJECTS` array in
`js/app.js` and the `<option>` list in `index.html`. The selector and
**Download all** reappear by themselves once there are two or more. The
code must already exist in the shared `projects` table: `WS`, `DT`, `WL`,
`JL`, `JT`, and `WD` are seeded there, so any of those works with no
Supabase change.

## Handheld scanners

A USB or Bluetooth scanner types into the **Manual entry** field, which
stays focused between scans, same as before.

## Report

One CSV row per set: `project`, `complete`, old
(`raw_code`/`ebom`/`traceability`/`scanned_at`), new (same four), 1D
(`barcode_raw_code`/`barcode_scanned_at`),
`correlation_id`.

## Setup

1. **Database.** This uses the same Supabase project as
   scan-code-reader1, with its own table. Open that project's SQL Editor
   and run [`migrations/001_triple_scans.sql`](migrations/001_triple_scans.sql)
   once. `js/supabase-client.js` already has the URL and anon key.
2. **Run it locally.** Use any static server, e.g. `python -m http.server 8000`.
   Camera access needs `localhost` or HTTPS.
3. **Deploy.** Push to GitHub and enable Pages (Settings → Pages → Deploy
   from branch, `main` / root).

## Keeping Supabase awake

Free Supabase projects pause after about 7 days with no activity.
[`.github/workflows/keep-alive.yml`](.github/workflows/keep-alive.yml)
reads one row every 3 days to prevent that. It covers scan-code-reader1
too, since both use the same project. If a run fails, GitHub emails you.
That usually means the project got paused anyway: resume it in the
Supabase dashboard. To test it by hand: Actions tab → Keep Supabase
awake → Run workflow.

## Files

```
index.html                       the whole UI
js/app.js                        scanning, parsing, checks, saving, set logic
js/supabase-client.js            Supabase URL/anon key + client
js/theme.js                      dark/light toggle
vendor/html5-qrcode.min.js       scanning library (Apache-2.0)
migrations/001_triple_scans.sql  table + open RLS policies
```
