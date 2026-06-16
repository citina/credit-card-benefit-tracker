# Project status — Credit Card Benefit Tracker

_Snapshot: 2026-06-15._

## State: deployed & working ✅
Google Apps Script + Google Sheets + Gmail, deployed as a private web app
(**execute as me / access "Only myself"**). Data in a `Benefits` sheet in the owner's account.

## What it does
- **Daily email reminder** (`sendReminders`, 09:00 local) lists benefits still to use, each with
  Done / Snooze links + a dashboard link. **Period-driven:** each benefit is nudged at the start
  of its period and again as it nears expiry — no per-benefit "remind every N days" knob.
- Email links open a **confirmation page** — nothing changes until you tap confirm (no silent
  GET mutations; safe against link prefetch/scanners).
- **Dashboard** (web app): benefits grouped by card; per-benefit **Mark done / Snooze / Undo /
  Un-snooze**; summary = tracked / still to use / done. A **sort control** reorders benefits
  *within* each card (Expiry / Amount / Name / sheet order), with **done benefits pinned to the
  bottom** of each card. Pending rows show days-left + expiry; **done** rows show when the credit
  **resets** (start of next period).
- **Snooze** is a two-step menu: tap Snooze → **Pick a date / Skip this period / Cancel**; "Pick a
  date" opens a **date picker** with Confirm / Cancel, "Skip this period" snoozes through period end.
  The picked date is
  **server-clamped so it never lands past the benefit's expiry**; a snoozed row shows "Snoozed until
  <date>"; snoozed still counts as "still to use" (only Done reduces that count).
- **Reset cadences:** monthly / quarterly / semiannual / annual / once (calendar-based), with
  forgiving input parsing (`normalizeReset_`).
- **Bilingual:** `CONFIG.LANG` = `'en'` | `'zh'` switches the whole UI + email.
- Done-status is **derived** (`LastDonePeriod` == current period key) → auto-resets at period
  boundaries, no reset job.
- **Add-cards wizard** (`+ Add cards` / `?view=add`): pick a card → its pre-researched 2026
  benefits render as editable rows (opt-in, unchecked) → tick/tweak/add-missing → written to
  `Benefits` (auth + lock + dedup). A **Select all / Clear all** bar toggles every visible row.
  Catalog ships in code, seeded into an editable `Catalog` sheet.
- **Edit / remove cards** from the dashboard card **⋮** menu: **Edit card** reopens the wizard in
  edit mode (current rows prefilled + un-added catalog benefits offered; `updateCard` updates in
  place, preserving done/snooze state); **Remove card** deletes the whole card (with a confirm step).

## Files
| File | Purpose |
|------|---------|
| `Code.gs` | Engine: config, i18n `STRINGS`, `setup`, reminders, web app, actions, catalog + add-cards |
| `Index.html` | Dashboard (+ "+ Add cards" link) |
| `Confirm.html` | Email-link confirmation page |
| `AddCards.html` | Add-cards catalog wizard (`?view=add`) |
| `SETUP.md` | Deployment guide |
| `BUILD_SPEC.md` | Authoritative design doc |
| `HANDOFF_add-cards-wizard.md` | Spec for the next feature (not built yet) |

## Config (top of `Code.gs`)
`EMAIL` (owner) · `LANG` · `AUTHORIZED_EMAILS` (`[]` = owner-only) · `TOKEN` (defense-in-depth) ·
`DEFAULT_REMINDER_DAYS` 4 (legacy) · `SNOOZE_DEFAULT_DAYS` 3 · `DAILY_HOUR` 9 · `SHEET_NAME` `Benefits` ·
`SNOOZE_PRESETS` `[1,3,7,14]`.

## Verified working
- Mark done **persists after reload** (fix: `LastDonePeriod` stored as plain text so `2026-06`
  isn't coerced into a Date).
- Email reminder received; Done link → confirm page → write succeeds.
- Snooze picker shows expiry-capped options; "Snoozed until …" displays correctly.

## Key safety / design notes (keep these)
- **Security:** only the owner can access (Google identity-gated; token is secondary). All writes
  go through `google.script.run` + `LockService`; no side-effecting GETs.
- `LastDonePeriod` cell **must stay plain-text** (`setNumberFormat('@')`).
- Set the Apps Script **project time zone** (period boundaries + the 9am send follow it).
- After any code change, **re-deploy a NEW version** (Manage deployments → Edit → New version).

## Sharing model
Share the **code**; each friend runs their **own private copy** (own Sheet + Apps Script,
"Only myself"). The benefits catalog (next feature) ships in code so friends get it too.

## Pending / next
- **Add cards wizard — built** ✅ (`AddCards.html` + `getCatalog`/`addBenefits`/`setupCatalog` in
  `Code.gs`). Catalog seeded: CSP / Amex Gold / Amex Platinum / CSR, verified 2026-06; opt-in
  (unchecked); editable `Catalog` sheet; benefit names English. Spec: `HANDOFF_add-cards-wizard.md`.
  **To go live:** add the `AddCards` HTML file in the editor, re-run `setup()` (seeds the `Catalog`
  sheet), and re-deploy a new version.
- The `Benefits` sheet still holds the **4 example rows** — replace them with your real cards
  (now easiest via the wizard, then delete the examples).
- **Follow-ups & backlog:** `HANDOFF_followups.md` — the 6 open questions were resolved 2026-06-15/16
  (done-row resets, within-card sort with done pinned to the bottom, two-step snooze with date picker +
  "Skip this period", add-page select-all; partial-use deferred; cycle colors declined). Live backlog:
  annual-fee + realized-value bar, anniversary-year reset, partial-use, catalog freshness.
- **Next build (annual fee + realized-value progress bar):** full self-contained brief in
  `HANDOFF_annual-fee-progress.md` — realized value accumulates over the **annual-fee period**
  (cardmember anniversary year from the open date), resets on the anniversary.
- **Local check:** `node verify.js` (parses Code.gs + HTML, runs logic under GAS stubs; 0 = green).
