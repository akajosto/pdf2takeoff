# Stage 2 browser verification plan

This checklist is for the draft `stage2-transactional-rebuild` branch. Run it in a browser with the real PDF.js worker and a current build. Keep a copy of the current project before testing.

## 1. Baseline and ordinary PDF opening

- [ ] Open a known multi-page PDF and confirm page 1 renders.
- [ ] Navigate forward/backward; confirm page count and page indicator.
- [ ] Exercise zoom in/out, fit width, wheel zoom, drag pan, and measurement tools.
- [ ] Create a length, area, count, and annotation; confirm the take-off table and overlay agree.
- [ ] Save the project as `.p2t`; save annotated PDF and export the take-off workbook.
- [ ] Open a second valid PDF. Confirm the new drawing appears and the old document is replaced only after the new first page renders.
- [ ] Open a corrupt/non-PDF file. Confirm the existing drawing, measurements, calibration, page, zoom, and selection remain usable and unchanged.

## 2. Project round-trip

- [ ] Reopen the saved `.p2t` file.
- [ ] Verify PDF pages, page number, markups, annotations, page calibrations, viewports, presets, custom columns, template, display unit, and layer metadata.
- [ ] Verify parent/sub-item relationships, links, formulas, notes, status, timesing, and visibility survive.
- [ ] Verify a project containing a large embedded PDF opens without a blank canvas or a stuck loading indicator.
- [ ] Export the reopened project and compare the quantities and annotations with the pre-save version.

## 3. Invalid project files

With a known good drawing already open, attempt each invalid project and verify the existing drawing remains usable:

- [ ] Malformed JSON.
- [ ] Invalid Base64 or a Base64 payload that is not a PDF.
- [ ] Unsupported format/version.
- [ ] Invalid page number or a markup/annotation/calibration/viewport referring to a page beyond the PDF page count.
- [ ] Duplicate markup, annotation, viewport, or layer IDs/names.
- [ ] Invalid numeric values (non-finite values, zero/negative calibration, zero timesing/depth/stroke width, opacity outside 0–1).
- [ ] Cyclic parent hierarchy or malformed layer references.

## 4. Replacement lifecycle and interaction

- [ ] Open a large/slow PDF and attempt toolbar actions, keyboard shortcuts, page navigation, zoom, pan, layer changes, and a second open while loading. No partial interaction should alter the in-flight replacement.
- [ ] Cancel/interrupt a render during a replacement if the browser/test harness permits it. Confirm the old page is restored and no late render overwrites it.
- [ ] Force first-page render failure in a development test harness. Confirm the old PDF canvas, SVG viewBox, page dimensions, scroll position, and application state are restored.
- [ ] Force rollback rendering/restoration failure. Confirm the error is explicit and the UI does not claim that rollback succeeded.
- [ ] Verify the loading indicator and workspace interaction lock always clear after success and failure.
- [ ] Verify previous-document cleanup errors are reported as warnings while the newly committed drawing remains interactive.

## 5. Session and persistence

- [ ] With live session enabled, start a replacement and force it to fail. Confirm the prior session resumes and queued remote changes are applied.
- [ ] Complete a replacement. Confirm the old session stops and remote changes from the old drawing are not applied to the new drawing.
- [ ] Confirm autosave stores only the committed drawing/take-off, not a transient partially opened candidate.
- [ ] Refresh and reopen the same PDF; confirm the expected saved session is restored.

## 6. Release gate

- [ ] `npm ci`
- [ ] `npm run check:project-open`
- [ ] `npm run build`
- [ ] `npm run check:deploy`
- [ ] Full CI workflow passes.
- [ ] Browser/PDF.js tests above pass on at least one Chromium-based browser.
- [ ] No merge, push to the development branch, or release until all required checks are green.
