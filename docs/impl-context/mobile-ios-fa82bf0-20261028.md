# iOS ordinary Release acceptance — 2026-10-28

Source `fa82bf05f34f0f0a9351d934190fdee3084072b9`, ordinary embedded Release, no Metro, all diagnostic flags disabled. iPhone 18 Pro / iOS 27 simulator `50231799-2BC1-4440-BEA8-D0F4F8EE40C0`. Data-preserving installation succeeded; installed main.jsbundle SHA256 `4e1fd154e0f696f137a178491808c0c1336f00ab4082e4c73b70c633706a7c6d` matches the build. [Build evidence](mobile-evidence/20261028/release-fa82bf0.json).

The new isolated bucket fixture has a durable local ownership ledger under ignored `apps/mobile/dist/acceptance/private/20261028`. No original user's content or bucket envelope was changed. Invitation and passphrase were loaded from private files; they are not included in the report or tracked automation. Native UI was exercised using Maestro 2.11.0 / XCTest and simctl.

| Step | Result | Boundary |
|---|---|---|
| Native invitation/password/hydration | PASS | Native secure field accepted password, Connect completed and iOS Native Bucket20261028 appeared. Form fields fit within screen width. |
| Record input then related-document navigation | PASS | Exact Notes `IOSPhoneSavedFA82` entered; related document opened without an explicit blur before navigation. |
| Document input/save/return | PASS | `IOSDocumentSavedFA82` inserted into synthetic body; Return showed the exact saved Notes. |
| Kill/relaunch and document recovery | PASS | stopApp/launchApp then document deep link displayed exact body marker with no editor-unresponsive message. This was online, not an offline-cold-start result. |
| Phone → desktop via actual bucket | PASS | Independent desktop pull and inspection showed exact Notes and document marker, preserving original attachment references. |
| Desktop → phone via actual bucket | PASS | Desktop wrote `DesktopIOSReturnFA82`, pushed; native settings manual sync and record reopen showed exact returned value. |
| Native navigation theme | PASS for observed screens | System dark mode updated record native header, form and document/editor consistently. Returning to light restored light header/form. Original light system appearance restored. |
| Complete iOS/bucket acceptance cell | INCOMPLETE | No fresh offline network isolation, record creation/board ordering, new attachment import, failure recovery, gesture, Chinese IME or accessibility matrix established by this run. |

Failures in the test execution remain available privately and are not converted into passes: first join flow's hideKeyboard command failed despite a visible submit button; a separate submit flow passed. First record assertion used the old fixture's Notes label and failed; corrected assertion used the observed new fixture. First desktop-return flow assumed Close returned directly to tabs, but a document remained in the stack; observed Return navigation then passed. These failed scripts are preserved alongside successful continuations.

Private raw location: `apps/mobile/dist/acceptance/20261028/ios/private`, including join-run, submit-run, record-run, record-v2-run, document-run, desktop-return-run and desktop-return-v2-run. Credential-containing join logs remain private. Sanitized screenshots below contain only synthetic record/document content.

- [Dark record and native header](mobile-evidence/20261028/ios-fa82-record-dark.png)
- [Light record with desktop return](mobile-evidence/20261028/ios-fa82-record-light.png)
- [Dark document/editor](mobile-evidence/20261028/ios-fa82-document-dark.png)

This is simulator functional evidence. No physical-device, cold-launch performance, four-cell completion or stable-daily-use acceptance claim is made.
