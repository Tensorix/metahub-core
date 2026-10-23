# Object sharing dialog

## Overview

This is a local surface specification for `src/webui/object-share-dialog.tsx`, its model, and the scoped sharing rules in `src/webui/styles.css`. It does not replace the website or product-wide design system. Mode: **Operate**. The intended character is quiet, clear, and Notion-like, within Metahub's existing visual identity.

The primary decision is where the object is hosted: users need to know which device or bucket serves it and the consequences for availability and content freshness. Access permissions and copying follow that decision. Creating another link, inspecting storage details, and maintaining a snapshot are secondary tasks. Existing sharing opens as a list of links, with hosting as the main row label; an object without links opens creation directly. There is no tab bar or simultaneous creation form and management list.

### Research rationale

Official product documentation reviewed on 2026-10-23:

- [Figma: Share files and prototypes](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes) separates link sharing from invitations and exposes further permission settings when needed. Applied here: keep access meaning and copying explicit; disclose maintenance separately. Unlike Figma, Metahub has multiple hosting destinations, so the destination decision comes first.
- [Google Drive: Share files](https://support.google.com/drive/answer/2494822) describes who can access a link separately from what recipients can do. Applied here: pair “持有链接的人” with “可以查看 / 可以编辑” before showing technical details.
- [Dropbox: Set shared link permissions](https://help.dropbox.com/share/set-link-permissions) treats passwords and expiry as link controls, distinct from membership permissions. Applied here: retain visible expiry, put optional password behind disclosure; keep hosting prominent.

These are design inferences from documented workflows, not claims of usability testing or pixel-level copies. Metahub does not gain the invitation, identity, organization, or membership ACL features of these products by adopting their information hierarchy.

### Product constraints

- Snapshot links share an exported version. Later edits do not synchronize automatically. Snapshot access is read-only; signed-link duration is capped at seven days, including when a remembered live-link duration is longer or unlimited.
- Live links expose current content and require the hosting device/server to remain online. Available permissions are view and edit.
- Access is link-based, optionally protected with a password. Creation sends `grants: null`; the UI must not imply invited-user access control.
- Renewing a snapshot preserves content. Updating a snapshot replaces its content and renews access. These operations must remain distinguishable.
- Revocation may return `cleanup_pending`; this is pending confirmation, not proof that access has already stopped. Provisioning is likewise not a usable-link state.

## Colors

Reuse the theme exported by `src/core/ui-theme.ts` through existing CSS variables: `--bg`, `--surface`, `--surface-2`, `--fg`, `--fg-soft`, `--muted`, `--line`, and `--accent`. Error feedback uses `--danger` and `--danger-soft`. Both theme palettes remain authoritative. The blue primary button indicates the next action; storage kinds do not introduce decorative color coding.

## Typography

Inherit the app font stack and `--fs-ui`, `--fs-sm`, and `--fs-xs` scale. The dialog title is 18px/600 and hosting row names use the app UI size at weight 600. Secondary explanations use muted text with generous line height. Dates use tabular numerals. Long object names, addresses, and host names truncate in rows; full values remain available in accessible button names.

## Layout

The shared Modal is 560px wide, subject to its viewport constraints. The title and object subtitle share one baseline; the subtitle stays on one line and truncates with a full-text tooltip. Desktop body padding is 22px above, 16px below, and 28px horizontally, with 20px between main groups. Existing links: object identity, a flat hosting-first list, and a quiet new-link footer. Each row shows host name, permission and expiry, with a copy action and an overflow menu. Details expand by clicking the host name or choosing Link details. On mobile, actions wrap beneath each row.

There is no current-link selector; all links remain visible. Creation starts with a labeled hosting selector listing concrete devices/servers and buckets in separate groups. Its derived explanation describes live content requiring an online host or a fixed snapshot independent of the local device. Content behavior is not a second selectable input. Permission and expiry follow; “更多设置” reveals only password. Existing links lead with their actual hosting source. Creating another link preserves the selected link’s host when that destination can be resolved. Selecting a bucket resets permission to view and caps duration to seven days.

At widths up to 560px, horizontal padding becomes 20px, footer and access rows can wrap, and form/button targets grow to at least 40px. The implementation retains native selects and disclosures.

## Elevation & Depth

Use the shared modal elevation and a flat interior. Section dividers establish grouping; avoid nested cards. Footer buttons have no local shadow. Loading uses static tonal placeholders rather than attention-seeking animation.

## Shapes

The dialog has a 12px corner radius. Controls, feedback, and quiet actions reuse `--radius-sm`. Borders indicate inputs and structural divisions, rather than enclosing every information group.

## Components

### State flow

| State | Main surface | Primary action |
| --- | --- | --- |
| Loading | Accessible loading placeholder | None |
| Load failure | Explanation and retry | Retry loading |
| No links / explicit creation | Creation settings | Create and copy |
| Active | Access summary and content facts | Copy link |
| Expired snapshot | Expired access explanation | Renew and copy |
| Expired live link | Expired access explanation | Recreate link |
| Provisioning | Hosting is not ready | Refresh state |
| Cleanup pending | Revocation unconfirmed | Retry revocation |

Creation success returns to the list. Copy feedback belongs only to the affected row. A snapshot lacking a usable signed URL obtains a renewed URL before copying. Copy success changes the button label and announces status; clipboard failure exposes a selectable URL for manual copying.

Each row’s overflow menu contains snapshot replacement, renewal without replacement, opening the available URL, and revocation as applicable. Replacing content and revoking open focused confirmation views with explicit consequences. Busy state blocks duplicate submission. Errors use an alert; non-error updates use status announcements. Focus returns to the primary action after relevant transitions.

### Validation limits

For this implementation pass, 24 related Bun tests and the component bundle passed. Desktop, creation, narrow-screen, and dark-theme previews were inspected using simulated data. The whole-repository type check still reports pre-existing errors in generated distribution assets, other modules, and readonly fixtures; no reported errors were in the changed implementation or newly added tests. This is not a clean repository-wide type-check result.

This document records implementation and research, not independent proof of deployment. Mocked component tests and browser previews can validate rendering and state transitions but cannot establish real storage renewal, live-host connectivity, clipboard permissions across browsers, or completed remote revocation. Live integration checks and assistive-technology checks remain distinct from visual inspection. Do not describe a pending cleanup as a verified revocation or a simulated preview as production data.

## Do's and Don'ts

- Do lead with the concrete hosting destination and its availability/content implications, then access and expiry.
- Don’t hide hosting in advanced settings or ask users to select both hosting and its derived content behavior.
- Do retain one clear primary action per state and distinguish snapshot renewal from content replacement.
- Do preserve accurate pending, expired, error, and clipboard-failure states.
- Don't add invitations, member avatars, organization access, or ACL promises unsupported by the backend.
- Don't offer permanent snapshot links or editable snapshots.
- Don't turn this surface specification into a new global branding system.
