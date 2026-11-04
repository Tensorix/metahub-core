# Metahub Mobile

Metahub Mobile lets people return to their own Metahub documents, work with structured tables and records, and open published Sites from an iOS or Android device. Its durable product direction is native navigation and controls on each platform, with a local workspace replica and explicit synchronization state.

## Product contract

- The mobile application reads and edits a per-workspace SQLite replica. HTTP servers and object-storage buckets are synchronization targets; the app is not an online-only HTTP viewer.
- Document editing uses the shared CM6 editor bundled inside a WebView, connected to the native host. The editor shell itself does not require a server download.
- Preserve workspace separation, existing record/document management, editing, search, history, and synchronization behavior as the browsing experience evolves.
- Use the native language of each OS: iOS navigation, search, menus, and segmented controls; Android Material 3 controls, top search, and floating creation.
- Offline availability applies to locally present data and assets. A local replica is not a promise that every remote resource or published Site works offline.

## Current browsing scope

The user-confirmed source is Metahub document `doc_doc-l7nlls` (《移动端布局设计》), captured in `../../docs/impl-context/mobile-redesign-20261104.md`.

Home shows recently used Sites as circles with labels and a final “更多” entry, followed by recently opened documents. The implementation limits these to five Sites and twelve documents and filters missing content. Recents are device-local and workspace-scoped, not cross-device activity statistics. The empty document state leads to the library.

The library switches between documents and tables with a native segmented control. Document browsing includes capped tree indentation, query filtering, and pages of sixty items. Tables lead into the existing database experience. Settings remain available.

On iOS, the rightmost tab is the true system Search Tab. Browse screens use collapsing transparent native large titles, pull-down search, and a trailing create menu for documents and tables. Android uses Material 3 search at the top and a floating create action.

## Sites boundary

The app reads synced Site metadata and available public publishing channels. It opens valid HTTP(S) published URLs; HTTP workspaces can also use their server’s public Site URL. Workspace credentials are not forwarded to these addresses. Synced inline PNGs can supply shortcut icons; unavailable images fall back to a first character.

There is no mobile local Site runtime. An unpublished Site in an object-storage workspace has no usable published link and cannot run offline. Do not describe the current shortcut experience as offline Sites.

## Open product decisions

A local mobile Site runtime, cross-device recent activity, pinned/favorite shortcuts, and richer tablet layouts are separate future decisions. They are not implied by the current browsing implementation. Native device, larger-text, and accessibility acceptance should be verified independently of source extraction.

## Scope of the design record

`DESIGN.md` records source-grounded visual roles and native platform behavior. No separate aesthetic metaphor, marketing positioning, or new brand identity was requested. Product-specific home composition belongs here; it is not a prohibition against other layouts elsewhere in the app.
