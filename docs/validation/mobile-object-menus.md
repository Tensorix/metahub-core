# Mobile document/database menus — 2026-11-11

Both native headers now expose a share button and a share menu action.
Documents expose copy ID, create duplicate (after flushing), and the existing
version history. Databases expose duplicate, recent activity, copy ID, rename,
share and confirmed deletion. Database activity uses the same local history
aggregation as Web, showing up to 200 entries and field before/after values.

The shared native share screen supports link creation, optional password,
one/seven-day expiry, copying, system sharing and revocation. HTTP workspaces
use the existing Web sharing endpoints, default to read-only and allow explicit
edit permission. Publication requires a completed sync with no queued writes.
Bucket workspaces use the existing encrypted read-only snapshot format and
viewer, including attachment byte resolution and link renewal.

Verification:

- 26 Bun tests passed across mobile sharing, document actions, recovery barrier,
  core snapshot export and short links (95 expectations).
- Mobile TypeScript and lint passed; diff whitespace check passed.
- Latest iOS Release built and installed on Metahub Preview. Both native menus,
  document/database share entry, share-page return navigation, and populated
  database recent activity were visually checked.
- No user records were duplicated/deleted/edited and no actual sharing link was
  created or sent during simulator verification. Production bucket publication,
  recipient access, native share destinations and Android runtime are not
  claimed as end-to-end verified by this change.

Screenshots: `menu-doc.png`, `menu-db.png`, `menu-share-final.png`,
`menu-activity.png` under
`/Users/noah/.codex/visualizations/2026/11/09/01a1bf0c-92ce-7363-8a3b-79dc4975b23e/database-alignment/`.

## Expo UI polish

Replaced cycling text actions with native Expo UI Picker controls. Share actions
use Expo UI Button, password input uses the existing Expo UI TextInput bridge,
and the activity repair filter uses Expo UI Switch. Native Host now measures
password content vertically without shrinking its width. Primary/secondary and
destructive actions, input surfaces, empty/loading feedback and activity text
hierarchy use the existing theme roles. Content width is capped on wide layouts.

Reviewed expo-overview, expo-ui, expo-native-ui and expo-router skills. Mobile
typecheck and lint passed. Rebuilt and installed iOS Release; inspected light and
dark share layouts, populated activity and the native expiry picker with its
selected state. Simulator appearance was restored to light. Final screenshots:
`polished-share-light-final.png`, `polished-share-dark-final.png`,
`polished-picker-final.png` in the directory above.

Android, tablet, enlarged text and VoiceOver were not visually verified in this
polish pass. No claim of complete device/accessibility acceptance is made.

### iOS button correction

The share actions now resolve to `share-action.ios.tsx` on iOS, directly using
`@expo/ui/swift-ui` Button/Text with borderedProminent/bordered button styles,
large control size and a flexible label frame. Removed onLayout-based width
measurement and pixel subtraction. Android/web keep the universal fallback.
Typecheck, lint and the iOS Release build passed. Installed and visually
confirmed the full-width SwiftUI primary button on Metahub Preview.

The iOS action styles now select `glassProminent` (primary) and `glass`
(secondary) on iOS 26+, retaining bordered styles on older iOS versions.
Destructive actions keep their native destructive role.
