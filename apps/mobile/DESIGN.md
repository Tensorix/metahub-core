---
name: Metahub Mobile
description: Native mobile access to Metahub documents, tables, and published Sites.
colors:
  light-bg: "#ffffff"
  light-surface: "#fbfbfa"
  light-surface2: "#f1f1ef"
  light-sidebar: "#f7f7f5"
  light-fg: "#2c2c30"
  light-fgSoft: "#5b5b62"
  light-muted: "#75757f"
  light-line: "#ebebe8"
  light-lineStrong: "#dededb"
  light-accent: "#4a55d6"
  light-accentFg: "#ffffff"
  light-accentSoft: "#eef0ff"
  light-danger: "#d6473b"
  light-dangerSoft: "#fdeceb"
  light-success: "#1f8f3e"
  light-hover: "rgba(45,45,55,0.045)"
  light-codeBg: "#f8f8f6"
  dark-bg: "#1a1a1c"
  dark-surface: "#202022"
  dark-surface2: "#2a2a2d"
  dark-sidebar: "#171719"
  dark-fg: "#e6e6e9"
  dark-fgSoft: "#b4b4bb"
  dark-muted: "#8b8b95"
  dark-line: "#2c2c30"
  dark-lineStrong: "#3a3a40"
  dark-accent: "#7b86ff"
  dark-accentFg: "#14141a"
  dark-accentSoft: "#23243a"
  dark-danger: "#f87168"
  dark-dangerSoft: "#341e1c"
  dark-success: "#3fb950"
  dark-hover: "rgba(255,255,255,0.05)"
  dark-codeBg: "#1d1d20"
typography:
  body:
    fontSize: "16px"
  ui:
    fontSize: "15px"
  small:
    fontSize: "13px"
  caption:
    fontSize: "12px"
  browse-title:
    fontSize: "17px"
  section-title:
    fontSize: "22px"
    fontWeight: 700
rounded:
  sm: "6px"
  md: "8px"
  lg: "14px"
  xl: "16px"
components:
  record-card:
    backgroundColor: "{colors.light-surface}"
    rounded: "{rounded.lg}"
  record-title:
    textColor: "{colors.light-fg}"
    typography: "{typography.ui}"
  browse-title:
    textColor: "{colors.light-fg}"
    typography: "{typography.browse-title}"
  site-label:
    textColor: "{colors.light-fg}"
    typography: "{typography.small}"
---
# Design System: Metahub Mobile

## Overview

**Creative North Star: "Follow the platform"**

Metahub Mobile follows the native interaction language of each operating system. SwiftUI and the iOS navigation system own iOS controls; Jetpack Compose and Material 3 own Android controls. Shared content keeps the same semantic color roles and information hierarchy, without requiring identical platform chrome.

This is a source extraction of the mobile app, not a new brand identity. Native system typography, native materials, and native state feedback remain authoritative. The website design system is outside this document’s scope.

**Key Characteristics:**

- Shared semantic colors with light and dark appearances.
- Platform-owned navigation, search, menus, pickers, and sheets.
- Readable content rows, restrained separators, and compact record metadata.

Source snapshot: 2026-11-04, Expo SDK 58. The user-confirmed native direction is recorded in `PRODUCT.md`; this file captures the implemented visual system. “Follow the platform” names that existing direction, not an invented aesthetic commitment.

## Colors

The fixed fallback palette combines an indigo action accent with neutral content surfaces and separate semantic status colors. Frontmatter values are extracted verbatim from `src/lib/theme/tokens.ts`; `light-*` and `dark-*` denote appearance variants, not separate products.

### Primary

`accent` marks actions and selection, `accentFg` supports content on accent fills, and `accentSoft` supplies a quieter selected/container surface. The frontmatter component examples use the light fallback only; resolve the active appearance at runtime.

### Neutral

`bg` is the main canvas; `surface` and `surface2` layer content; `sidebar` supplies navigation/grouped surfaces. `fg`, `fgSoft`, and `muted` distinguish text prominence. `line` and `lineStrong` define separators. `hover` is the shared pressed/hover wash, and `codeBg` distinguishes code content. `danger`, `dangerSoft`, and `success` are status roles, not decorative secondary brand colors.

### Adaptive platform roles

Android does not render the fallback hex palette directly. `src/lib/theme/material.android.ts` maps the same semantic roles to Material 3:

| App role | Material role |
| --- | --- |
| bg | background |
| surface / surface2 / sidebar | surfaceContainerLow / surfaceContainerHigh / surfaceContainer |
| fg / fgSoft / muted | onBackground / onSurfaceVariant / outline |
| line / lineStrong | outlineVariant / outline |
| accent / accentFg / accentSoft | primary / onPrimary / primaryContainer |
| danger / dangerSoft | error / errorContainer |
| codeBg | surfaceContainerHigh |

Android uses the light accent as its seed by default. When enabled and supported, Material You supplies wallpaper-derived colors. Success retains the shared appearance-specific color because the mapping has no Material success role; the Android interaction wash is `onSurface` at 8% alpha. `NativeHost` gives native islands the same appearance and seed choice as the React Native shell. Navigation receives the resolved theme through `NavigationThemeProvider`.

**The Semantic Role Rule.** Resolve color through the active platform theme; fallback hex values do not override native adaptive roles.

## Typography

React Native text uses the system face because no application `fontFamily` is assigned in the sampled shared components. Native controls and navigation use their platform’s typography. Preserve those defaults, including the system navigation title hierarchy; do not assign a custom display face merely to make platforms look alike.

The shared `fs` scale is represented as `body`, `ui`, `small`, and `caption` in frontmatter. Browse row titles and section titles have their own observed roles. Record titles add medium weight to the UI size; secondary record properties use the small size and select-value chips use the caption size. No global line-height, letter-spacing, or modular type ratio is established by these files.

Source: `src/lib/theme/tokens.ts`, `BrowseRow.tsx`, `RecordCard.tsx`, and the home route. The bundled document editor has a separate content stylesheet in `scripts/build-editor.ts`; do not apply navigation typography to editor content.

## Layout

Browse screens use a single scrolling content column. Home and library content align to a horizontal inset (20 logical points); the horizontal Site strip and record cards use an inset (16 points). Browse rows have a minimum height (64 points), vertical padding (14 points), and capped tree indentation (16 points per level, up to three levels). These are component measurements, not a global spacing scale; no shared spacing-token object exists.

The library switch sits within the scrolling list header. iOS root scrolling containers use `contentInsetAdjustmentBehavior="automatic"` so the native large title and search can participate in scrolling. Keep the scrolling container discoverable by the navigator. Android lists reserve bottom space for the floating create action; `AdaptiveFab` accounts for safe-area consumption by tabs.

Site shortcuts have a target width (80 points), minimum height (100 points), a circular image (60 points), a label below, and a gap (10 points). The strip scrolls horizontally rather than shrinking those targets. Native library switch hosts have minimum heights (44 points on iOS, 48 on Android); their internal dimensions remain platform-owned.

The app currently declares portrait orientation and tablet support, but these sources do not define a tablet breakpoint or a separate multi-column layout. React Native numeric dimensions are logical layout units; frontmatter uses `px` only as the portable DESIGN.md representation.

## Elevation & Depth

Custom browse rows and record cards use tonal surfaces and thin separators, without a reusable custom shadow scale. Platform controls own their material and elevation: iOS native tabs retain system treatment, while Compose owns the FAB’s shape, elevation, and pressed feedback. `BrowseStack` requests transparent iOS navigation, hides explicit header shadows, and keeps the native large-title behavior. Do not synthesize web blur or shadow tokens from this configuration.

**The Native Material Rule.** Native controls own their material, geometry, and interaction feedback; the application supplies semantic intent and theme.

## Shapes

The shared radius scale in frontmatter comes directly from `radii`. Record cards use the large radius and a hairline border. Site shortcuts are circular; record select-value chips are pills. Those shapes describe those components, not every container. Native buttons, inputs, segmented controls, sheets, tabs, and the Android FAB keep OS-defined shapes.

## Components

### Buttons and creation

`NativeButton` wraps `@expo/ui` Button in `NativeHost`; form and menu actions use the existing filled/text variants. Native controls own disabled, pressed, and focus behavior. iOS browse creation is a trailing `Stack.Toolbar.Menu` with document/table actions. Android creation uses Compose `FloatingActionButton`, opening a native sheet for the same choices.

### Inputs and search

`RecordTextInput` wraps the native `TextInput`, applying accent cursor, muted placeholder, and foreground text while preserving editable native state through its bridge. It does not prescribe a universal field border or radius. iOS browsing uses `Stack.SearchBar` with scrolling visibility; Android uses the Compose search bar at the top of browse content. Search results reuse the existing document/record navigation.

### Navigation and segmented controls

`NativeTabs` supplies home, library, and settings. On iOS the rightmost trigger has `role="search"`; it is a real system Search Tab, associated with a nested native Stack/SearchBar. Android hides that trigger in favor of top search. iOS browse stacks use transparent, collapsing large titles. Icons use platform SF Symbols or Material assets.

Library switching uses a SwiftUI segmented Picker on iOS and `SingleChoiceSegmentedButtonRow` on Android. Selection and touch feedback belong to those controls, not a hand-drawn approximation.

### Browse rows and Site shortcuts

`BrowseRow` pairs a platform icon with a two-line title, optional single-line subtitle, bottom separator, and a theme interaction wash when pressed. Site shortcuts show a synced image when available, otherwise a first-character fallback; “更多” uses its own native icon and a neutral circular surface. A pressed Site shortcut reduces opacity (0.55).

### Record cards and chips

`RecordCard` shows one title and at most three compact properties. Its inner press target uses horizontal padding (14 points), vertical padding (11 points), and minimum height (44 points); pressing changes the surface tone. Select properties use the existing stable, option-string-derived palette in `src/lib/format.ts`, with separate light/dark arrays. Chip colors indicate option identity, not status or a new brand palette.

### Documentation previews

`.impeccable/design.json` provides self-contained HTML previews of shared content patterns and semantic adapters for native primitives. HTML cannot reproduce SwiftUI/Compose behavior, system Search Tab semantics, native glass, or dynamic colors. The native adapters and browser-only focus outlines are explicitly illustrative; source components and device behavior remain authoritative. No synthetic tonal ramp, shadow, motion, or breakpoint has been promoted to a source token.

## Do's and Don'ts

### Do:

- Do resolve application colors through useTheme and native controls through NativeHost.
- Do retain system typography, platform symbols, native materials, and built-in control states.
- Do keep iOS scrolling content compatible with automatic navigation insets and large-title collapse.
- Do preserve meaningful labels, native focus behavior, and copyable recovery details.

### Don't:

- Don’t replace the iOS system Search Tab with a visually similar ordinary tab.
- Don’t impose iOS control geometry on Android or hard-code the fallback palette over Material You.
- Don’t turn illustrative HTML previews into specifications for native control geometry or animation.
- Don’t claim that recorded values prove accessibility, tablet, or device validation.
