# Android native acceptance fragments

This directory contains 29 YAML fragments: 14 historical executed fragments, 7 executed ff9374a fragments, 3 executed 6d5c199 fragments and 5 unexecuted retest drafts. The 24 executed fragments have scope-qualified outcomes of 16 PASS, 5 PARTIAL and 3 FAILED; these counts describe fragment evidence, not complete product workflow gates. The first table indexes the 14 historical runs. They are not an independent full acceptance suite. Read each YAML prerequisite before replay; the selected workspace, synthetic fixture values, keyboard/cursor state and prior navigation matter. Replays mutate only the explicitly prepared disposable fixture. Do not run the directory as a suite or reset user data. Runner COMPLETED does not imply the broader product gate passed.

| Fragment | Tested source | Evidence status | Execution evidence |
|---|---|---|---|
| core-reference.yaml | ea130b8 | PASS | /Users/noah/.maestro/tests/2026-10-26_152841/core-reference/commands.json |
| document-return.yaml | ea130b8 | PARTIAL | /Users/noah/.maestro/tests/2026-10-26_152748/document-return/commands.json |
| board-move.yaml | ea130b8 | PARTIAL | /Users/noah/.maestro/tests/2026-10-26_153437/board-move/commands.json |
| create-record.yaml | ea130b8 | PASS | /Users/noah/.maestro/tests/2026-10-26_153805/create-record/commands.json |
| restart.yaml | ea130b8 | PASS | /Users/noah/.maestro/tests/2026-10-26_153832/restart/commands.json |
| offline-restart.yaml | 7d07c80 | PASS | /Users/noah/.maestro/tests/2026-10-26_154445/offline-restart/commands.json |
| home-create-menu.yaml | 7d07c80 | PARTIAL | /Users/noah/.maestro/tests/2026-10-26_154140/home-create-menu/commands.json |
| bucket-record-document.yaml | 6db2a4a | PASS | /Users/noah/.maestro/tests/2026-10-26_160031/bucket-record-document/commands.json |
| bucket-document-return.yaml | 6db2a4a | PASS | /Users/noah/.maestro/tests/2026-10-26_160137/bucket-document-return/commands.json |
| bucket-desktop-return.yaml | 6db2a4a | PASS | /Users/noah/.maestro/tests/2026-10-26_160246/bucket-desktop-return/commands.json |
| bucket-board.yaml | 6db2a4a | PASS | /Users/noah/.maestro/tests/2026-10-26_160537/bucket-board/commands.json |
| bucket-offline.yaml | 6db2a4a | FAILED | /Users/noah/.maestro/tests/2026-10-26_160653/bucket-offline/commands.json |
| bucket-attachment-import.yaml | 6db2a4a | PARTIAL | /Users/noah/.maestro/tests/2026-10-26_161428/bucket-attachment-import/commands.json |
| bucket-attachment-restart.yaml | 6db2a4a | PASS | /Users/noah/.maestro/tests/2026-10-26_161814/bucket-attachment-restart/commands.json |

Sources: `ea130b85762ae1a8155e4198922503df380f77f3`, `7d07c80d524187008aafef0b4dafe49f9ccee2ca`, and `6db2a4a2f84c76a5bcb3f6709a3d8239d72d5c56`. Full observations and external API/desktop checks are in `docs/impl-context/mobile-android-ui-final-20261026.md`. Historical evidence is outside Git; never copy raw connection screens, private history or device logs into evidence without sanitization.

After manually establishing the documented starting state, replay one fragment from repository root:

```sh
JAVA_HOME="<local JDK home>" \
MAESTRO_CLI_NO_ANALYTICS=1 \
MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true \
"<Maestro executable>" --device emulator-5554 test \
  apps/mobile/e2e/android/<selected-fragment>.yaml \
  --test-output-dir "<private local output directory>"
```

The executed fragments use synthetic literals and require no credentials or environment parameters. Some unexecuted drafts below require explicit nonsecret selector/marker parameters. Enrollment was performed by separate private flows, intentionally excluded here. If replaying a private flow that declares parameter placeholders, pass them explicitly (exported shell variables alone did not bind the historical Maestro input):

```sh
"<Maestro executable>" --device emulator-5554 test \
  -e MOBILE_UI_ENROLL_LINK="<private enrollment link>" \
  -e MOBILE_UI_PASSPHRASE="<private decryption password>" \
  "<private enrollment flow outside Git>" \
  --test-output-dir "<private local output directory>"
```

This is a parameter-binding example, not a provided standalone enrollment test. Keep real values, runner output, screenshots and command artifacts private. Do not print or commit them. Record/restore emulator radio state separately for offline tests; the YAML does not manage radios. `offline-restart.yaml` also requires separately pausing/resuming only the disposable server.

## New Release retests: not run

The five `retest-*` YAML files are drafts, separate from the fourteen historical runs above. None has device execution evidence or a source SHA yet. Confirm selectors against the new artifact before executing; missing `Select all`, a changed field coordinate or an old damaged starting value is a setup issue until inspected. Do not count an old artifact's result as testing the new fixes.

- `retest-fast-input.yaml`: clear the entire old synthetic Notes selection, enter exact `AndroidBucketOffline20261026`, close without explicit blur, reopen and compare exactly, then repeat the comparison after restart. Record actual input method/speed. For a true fast native-input reproduction, the operator must record the native injection sequence separately; the Maestro input command alone does not establish an input rate.
- `retest-form-save-cancel.yaml`: apply only after confirming document/view form controls; this generic Cancel/Save draft is not suitable for database management row Save plus header Close, with distinct synthetic markers. Cancel must leave the original value, then Save must persist the new value and exit. This draft does not navigate to each form or perform independent desktop verification.
- `retest-db-discard-after-continue.yaml`: dedicated draft for the native crash sequence. Start in synthetic database management, alter the full name, Close → Continue editing, confirm draft retained, Close → Discard changes, then reopen management and confirm the original name remains. Run only on the next parent-approved Release.
- `retest-share-open.yaml` and `retest-share-dismiss-edit.yaml`: use the same artifact and document. Open the native sheet, record a start time, keep it open for **more than 35 seconds**, record an end time, then run the dismiss/edit fragment. The hold is external to YAML; do not substitute an immediate animation wait for elapsed time. Verify the editor warning is absent after dismissal and the subsequent marker survives a native return/reopen. Parent coordinates independent desktop verification.

Parameterized draft example, after opening the chosen synthetic form and confirming coordinates/actions:

```sh
"<Maestro executable>" --device emulator-5554 test \
  -e FORM_FIELD_POINT="<freshly observed x%,y%>" \
  -e ORIGINAL_NAME="<synthetic original name>" \
  -e CANCEL_MARKER="<unique synthetic cancel marker>" \
  -e SAVE_MARKER="<unique synthetic save marker>" \
  -e REOPEN_FORM_ACTION="<observed native menu/form action>" \
  apps/mobile/e2e/android/retest-form-save-cancel.yaml \
  --test-output-dir "<private local output directory>"
```

Share drafts require explicit `FILE_BUTTON_POINT` and `BODY_TEXT_SELECTOR` parameters. Keep the sheet open between the two runs; a separately measured 36-second hold is suitable. Capture timestamps and screenshots without secrets. Parent currently owns the private desktop replica; coordinate before any pull/push/verify command.

## ff9374a executed retests

These seven additional `ff-*` fragments were executed on `ff9374a3885cfbfd1341fcfcd1674e7a0ff6c444`; they do not change the historical `retest-*` drafts into passes. See each leading comment and the report for exact starting state/evidence path.

| Fragment | Status | Boundary |
|---|---|---|
| ff-input-verify.yaml | PASS | Starts at bucket Home after full old Notes selection, rapid native exact input and immediate header Close. Verifies exact reopen/restart only. |
| ff-doc-form-confirm.yaml | PASS | Starts in new-document discard confirmation after canceled synthetic title. Covers Continue editing, discard and subsequent Save. |
| ff-share-document.yaml | PASS | Starts in newly saved AndroidSavedFF9374a document. Opens attachment doc and checks clean starting state only. |
| ff-share-edit.yaml | PASS | Starts in attachment document after actual native share held 63226ms and dismissed by one Back; verifies edit/save/reopen without editor warning. |
| ff-board-menu.yaml | PASS | Starts on bucket board with target record in partially visible Done column. Tests sibling menu Move to Todo and management entry only. |
| ff-db-save-cancel.yaml | PARTIAL | Starts in database management. Reaches dirty Close confirmation; old draft omitted confirmation handling, so its following original-name assertion failed. Save sections did not run. |
| ff-db-save-cancel-confirm.yaml | FAILED | Starts in dirty database Close confirmation after ff-db-save-cancel. Continue editing preserves draft; second Close and Discard causes real native ScreenStackFragment crash. Save and view steps did not run. |

The rapid input and share hold are externally orchestrated native actions, not encoded by these assertion fragments. Their measured timestamps are in the sanitized UI-retest JSON. For the crash sequence, run the setup fragment from database management, inspect the dirty Close confirmation, then use the confirmation fragment; it is a known failing native regression on this artifact. Parent requested stopping device work afterward.

## Next Release acceptance checklist: not executed

Wait for parent build/install and explicit device ownership before any step. Record new source SHA, APK hash and initial synthetic values; do not carry ff9374a PASS labels forward.

1. Database discard regression: use the dedicated draft above. Capture native state after Continue editing and after final Discard. Require the app to remain alive, return to the database, and show the original persisted name on reopening management. Escalate any native exception; do not repair application code during acceptance.
2. Database row Save and Close: separately start from the original synthetic name, select the full field and enter a unique save marker, tap the database-name row Save, then Close. Reopen management and require that saved value. Edit to a different unsaved marker, Close and confirm Discard; require the previously saved value. Finally restore the original name with the row Save and reopen to confirm restoration. Document that header Close is the cancel/exit action; there is no global database Save/Cancel form.
3. View form Cancel: enter one known synthetic view edit form, record its original name/layout/filter/sort, change only the name and Cancel. Handle the observed discard dialog if present, then reopen and require the original name and configuration. Confirm current labels before using the generic draft.
4. View form Save: edit the same view name to a unique save marker, Save, return/reopen and require the marker with original layout/filter/sort preserved. Restore the original name via Save. If only a create form is available, record that narrower scope instead of claiming edit/cancel preservation.
5. Document form: existing ff9374a Cancel/Continue/Discard/Save evidence stays attached to that source. Any rerun on the next Release must have a new evidence path; do not infer it from the old report. Parent alone coordinates desktop verification.

No device, test runner, build or fixture operation was used to prepare this checklist.

## 6d5c199 executed regression and ANR

`6d-db-discard.yaml` passed the previously crashing Continue editing → Close → Discard → original name → management reopen sequence on `6d5c199da28e9b69f64cd2146a27b03fcb501c71`. `6d-db-save-restore.yaml` passed row Save and later unsaved-discard substeps, but is FAILED overall: intended name restoration input ran 121,064ms while system input-dispatch ANRs occurred, then row Save completed and final Close failed because the system ANR dialog was present. Parent observed a persisted name missing one character; exact restoration is not accepted. View steps did not run. See the sanitized regression JSON and report. These are separate executions; the earlier NOT RUN drafts remain unexecuted files. Device was handed to implementation review for read-only ANR evidence, without selecting Wait or Close app.

`6d-fast-name-reopen.yaml` is a separately executed PASS control fragment after the original ANR was preserved. Its external native input completed in 206ms, full text was checked before Save and again afterward, and Close/reopen retained exactly `Android Native Bucket20261026`. Historical ANR event count remained 2→2, with no new event after the app-only relaunch. The original slow-input ANR remains unresolved; this control must not turn `6d-db-save-restore.yaml` into a PASS. Host/guest before/after load samples were collected separately by implementation review, without a causal conclusion here.

Historical /tmp raw outputs were no longer available on 2026-10-28. Paths in the original run descriptions are historical locators, not currently available proof. Retained sanitized repository evidence and the Oct28 report identify what can still be inspected. New private runs use ignored apps/mobile/dist/acceptance.
