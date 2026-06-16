# Handoff — credit-card tracker follow-ups

A self-contained brief for a fresh Claude Code session. **Read first, in order:** `STATUS.md`
(current snapshot) → `BUILD_SPEC.md` (design decisions, incl. the "Add-cards wizard (built)"
section) → `Code.gs` (engine). The original wizard spec is `HANDOFF_add-cards-wizard.md` (done).

## What this app is

A **credit-card recurring-benefit tracker** on Google Apps Script + Sheets + Gmail, deployed as a
private web app (**execute as me / access "Only myself"**). Data lives in a `Benefits` sheet.
Daily `sendReminders()` emails what's still to use; a web dashboard (`doGet`) shows status and lets
you act; an in-app wizard adds/edits cards instead of hand-editing the sheet. Bilingual (en/zh) via
`CONFIG.LANG`.

## Current state — built & verified

- **Catalog** (`CATALOG` constant, verified **2026-06**): Chase Sapphire Preferred, Amex Gold, Amex
  Platinum, Chase Sapphire Reserve — recurring "use-it-or-lose-it" credits only. `setup()` seeds an
  **editable `Catalog` sheet**; the wizard reads that (user edits win) else the constant.
- **Add-cards wizard** (`AddCards.html`, via dashboard **+ Add cards** or `?view=add`): pick a card
  (or "Other"), benefits render **unchecked (opt-in)**, tick/edit/add, **Add to my tracker**
  (`addBenefits` → auth + lock + dedup + batched write). Catalog/suggestion rows have **no ×** (tick
  to add); manually-added rows hard-delete on ×; success shows a **slim top banner** and resets to
  the picker.
- **Reminders are period-driven** (no per-benefit cadence): `shouldRemind_` nudges once at
  **period start** and once **near expiry** (lead days: monthly 5 / quarterly 10 / semiannual·annual
  30). `ReminderDays` column is **legacy/unused**.
- **Dashboard** (`Index.html`): benefits grouped by card; per-benefit **Mark done / Snooze / Undo /
  Un-snooze**; shows **days-left + expiry date** for pending benefits; numeric amounts auto-prefix
  `$`; empty amount → no em-dash. Each **card** has a **⋮ menu**: **Edit card** and **Remove card**
  (inline confirm; Cancel closes the menu). No per-benefit ⋮ — benefit removal is done in edit mode.
- **Edit mode** (`?view=add&edit=<card>`): prefills the card's current rows (checked, **no ×** —
  uncheck to remove; **user-added** rows show a **Delete** button once unchecked) **plus its
  not-yet-added catalog benefits** (unchecked). **Save** → `updateCard(card, items)`: id'd items
  whose values changed are updated **in place** (status columns `LastDonePeriod`/`LastReminded`/
  `SnoozeUntil` preserved; unchanged rows kept, not reported), unsubmitted rows deleted, new ones
  appended (delete bottom-up after writes). Success shows a **3-line summary** (Updated / Added /
  Removed with benefit names) + **Keep editing** (reloads from the returned fresh card state).
- **i18n**: every user-facing string in `STRINGS` (en/zh), surfaced via `uiStrings_()` /
  `addUiStrings_()`. Email + all pages localized.

## Verify & deploy

- **Verify locally:** `node verify.js` from the project root. It parses `Code.gs` + the HTML inline
  scripts and runs the pure logic (reminders, expiry, `updateCard`, `getCardRows_`) under GAS stubs
  — no Apps Script needed. Exit 0 = green. Extend it when you add logic.
- **Deploy:** paste `Code.gs`, `Index` (=Index.html), `Confirm` (=Confirm.html), `AddCards`
  (=AddCards.html) into the Apps Script editor (HTML files named exactly, no extension). Run
  `setup()` once (seeds `Benefits` + `Catalog`, registers the daily trigger). Then **Deploy → New
  deployment → Web app → execute as Me → access Only myself.** After any change: **Manage
  deployments → Edit → Version: New version → Deploy.** Set the project **time zone**.

## Constraints to preserve (do NOT violate)

- Deploy stays **execute as me / access "Only myself"**; never "Anyone". Every server function
  calls `requireAuth_()`. No new external/runtime network calls.
- **No side-effecting GET** — writes go through `google.script.run` + `LockService`. Email links
  open a confirm page that writes nothing.
- **`LastDonePeriod` stays plain-text** (`setNumberFormat('@')`) or monthly keys coerce to Dates.
- **i18n**: no hardcoded English; seed en + zh; keep them symmetric (verify checks 80/80).
- Calendar-based resets: monthly / quarterly / semiannual / annual / once.
- Flat visual design (warm-white `#faf9f5`, 12px radius, weight-500 headings); the only intentional
  shadow is the dashboard ⋮ popover.

---

## TODO — known issues to fix

1. ~~**[BUG] Edit summary lists unchanged benefits under "Updated".**~~ **FIXED 2026-06-15.**
   `updateCard` now diffs each resubmitted id'd row's new values (benefit/amount/category/reset/
   reminderDays) against the stored row and only pushes to `updates` / reports it as updated when a
   field actually changed; unchanged rows are still kept (`keep[id]=true`), just not reported. Diff
   normalizes both sides the same way (`validCategory_`/`normalizeReset_`/trim). `verify.js` gained
   `updateCard unchanged not listed` / `unchanged kept` / `unchanged status preserved` asserts
   (verify.js now has 27 logic asserts total, after the feature build below).

2. **[backlog] Annual fee + realized-value progress bar.** Per-card annual fee + a dashboard progress
   bar of realized value / fee. **Approach agreed 2026-06-16:**
   - **Annual fee** → a new editable `Cards` sheet (`Card | AnnualFee | OpenMonth`), seeded from a
     per-card catalog default (add `annualFee` to `CATALOG`). `OpenMonth` is also reusable for the
     anniversary fix (#3).
   - **Amount parsing** → a `parseAmount_` that extracts the number (`$12.95`→12.95, `$300`→300);
     non-numeric amounts (`Unlimited`, `12 visits`) are excluded from the bar.
   - **Realized value = accumulation over the annual-fee period** — the cardmember **anniversary
     year** counted from the card's open date, **NOT** the calendar year (the fee is billed per
     cardmember year, so "paid for itself" is measured over that same year). Add `RealizedValue` +
     `RealizedPeriod` (period start-year) columns — `markDone` adds the parsed amount, `undo`
     subtracts it, **lazily reset at the anniversary** (a row whose `RealizedPeriod` ≠ the current
     period reads as 0 — no cron). Per-card bar = Σ current-period `RealizedValue` / `AnnualFee`.
     Touches schema + `applyAction_` (done/undo) + `buildDashboardData_` + `Index.html`.
   - **Full build brief → `HANDOFF_annual-fee-progress.md`** (data model, pure helpers
     `parseAmount_` / `annualFeePeriodStartYear_` / `realizedAfterDone_`, UI, verify asserts, open
     questions). Not yet built — its own session.

3. **[backlog] Anniversary-year vs calendar-year reset (real correctness issue).** Period math treats
   every `annual` as a **calendar** year, but some Chase credits reset on the **cardmember anniversary
   year** — so for a non-January open date both the reset/expiry date AND the realized-value year (#2)
   come out wrong. **Which benefits (verified 2026-06 against Chase):**
   - **Anniversary-based:** CSP **Hotel credit (Chase Travel) $100**; CSR **Annual travel credit
     $300**. (Both now flagged in `CATALOG` comments.)
   - **Calendar-based (everything else):** all Amex Gold/Platinum credits (monthly / semiannual
     Jan–Jun·Jul–Dec / calendar year); CSR dining (Exclusive Tables), StubHub, The Edit, DoorDash,
     Lyft, Peloton; CSP DoorDash. (Chase states CSR dining/StubHub reset Jan 1–Dec 31.)
   **Fix:**
   - Add a per-benefit **`periodBasis`** (`calendar` | `anniversary`), default in `CATALOG` (mark the
     two above `anniversary`); store a per-card **open date** (month/day) in the `Cards` sheet
     (`Card | AnnualFee | OpenDate`) — shared with the annual-fee feature (#2).
   - Offset `periodKey_` / `periodStartDayNumber_` / `periodEndDayNumber_` / `periodRefreshDate_` for
     `anniversary` benefits by the card's open date; the `RealizedYTD` reset (#2) for those benefits
     rolls on the anniversary, **not** Jan 1.
   - **Add/Edit card UI:** let the user set each benefit's `periodBasis` and enter the card's open
     date (required for anniversary benefits). Catalog ships sensible defaults; the user can override.
   (Backlog items also in memory `credit-card-tracker-backlog.md`.)

4. **[backlog] Partially-usable benefits** (e.g. CSR DoorDash $25 = $5 restaurant + 2×$10). Today a
   benefit is a single done/not-done. **Deferred 2026-06-15** (keep as-is for now). Options when
   revisited: (a) split into separate catalog rows per sub-credit (no new data model); (b) add a
   "used X of Y" / multi-use model (new storage column(s) + UI). Decide the data model then.

5. **[backlog] Catalog freshness — new / changed benefits (raised 2026-06-16).** Issuers change
   benefits over time (amounts, cadence, new perks, dropped perks). Today: the `CATALOG` constant
   ships in code with a `lastVerified` date; `setup()` seeds it into an editable `Catalog` sheet
   (user edits win); the wizard reads that sheet. Gaps to handle when revisited:
   (a) **updating the catalog** — periodically refresh `CATALOG` amounts/cadence, add new benefits,
   drop dead ones, bump `lastVerified` (and/or have the user edit the `Catalog` sheet directly);
   (b) **surfacing changes to already-tracked rows** — edit mode only offers *not-yet-added* catalog
   benefits as suggestions; a benefit already on the card whose catalog amount changed is **not**
   flagged (consider a "catalog updated → sync?" hint comparing the row to the current catalog);
   (c) the manual escape hatch (wizard edit / manual-add, editable `Catalog` sheet) already covers
   anything missing today. Decide how proactive vs manual this should be. **Known stale (2026-06):**
   CSR **The Edit** is `$250 semiannual` in `CATALOG`, but from 2026 the two $250s are usable anytime
   in the year (effectively annual, no H1/H2 split) — update when refreshing the catalog.

---

## Open questions — resolved 2026-06-15 (built unless noted)

1. **Reset semantics / "resets on" affordance → BUILT.** Status is **derived, not a timed refresh**
   (`isDone_` flips to false once `periodKey_` rolls). Pending rows already showed `Nd left · expires
   <date>`; **done** rows now show a muted **`resets <date>`** line (start of next period). Server:
   `periodRefreshDate_` + `refreshInfo` in `buildDashboardData_` (string `resetsOn`); client: the
   `tail` in `Index.html` falls back to `refreshInfo` for done rows.

2. **Sort control → BUILT, within each card** (grouping preserved; flatten rejected). A sort `<select>`
   above the cards: **Expiry** (default, soonest first), **Amount** (biggest first), **Name**,
   **Default** (sheet order). `buildDashboardData_` now emits numeric `daysLeft`; client parses
   `amountNum` and re-sorts each card via `sortBenefits()` on change (cached in `LAST`, no round-trip).
   **Done benefits are pinned to the bottom of each card** — `sortBenefits` partitions into
   not-done/done first, then sorts within each group (so done rows never interleave with to-use).

3. **Partially-usable benefits → DEFERRED.** Kept single done/not-done for now; moved to backlog
   (TODO #4 above).

4. **Color-code cycles → SKIPPED** (declined; dashboard stays monochrome so status badges stay clean).

5. **Snooze rework → BUILT, now a two-step flow** (no preset day chips). Tap **Snooze** → a menu:
   **Pick a date** / **Skip this period** / **Cancel**. Tap **Pick a date** → a `<input type="date">`
   (`min`=tomorrow, `max`=period end) with **Confirm** / **Cancel**. The three phases (closed / menu /
   date) are mutually exclusive, toggled by `snoozePhase(wrap, phase)`; the two Cancels step back one
   level (menu→closed, date→menu). Confirm reads the input and calls `snoozeDate(id, value)` (defers
   reminders until that date); **Skip this period** (label for the `snoozeEnd(id)` action — through
   period end). Server:
   `snoozeEnd` / `snoozeDate` → `applyAction_`, clamped by the pure helper
   `snoozeUntilDayNumber_(action, reset, now, arg)` (null = too soon / bad date), noon-anchored
   `SnoozeUntil`. The email/confirm snooze path is unchanged (still fixed N days, so `SNOOZE_PRESETS`
   / `snoozeOptionsFor_` remain — the latter now only gates *whether* snooze is offered). Verified by
   5 snooze asserts.

6. **Add-card "tick all / clear all" → BUILT.** A `#bulkBar` above the benefit rows (`Select all` /
   `Clear all`) flips every visible, non-removed, enabled `.ben` checkbox. Shown whenever the benefit
   rows are visible (add + edit modes).

### Round-2 UI tweaks (2026-06-15)

- **Edit mode: no more `×`.** All edit-mode rows render with `removable: 'none'` (the soft dim/restore
  `×` is gone). A benefit is removed from the card simply by **unchecking** it (`updateCard` deletes
  any of the card's rows not resubmitted). For **user-added** (non-catalog) benefits, `getCardRows_`
  now returns a `custom: true` flag; in `makeRow` such rows show a red **Delete** button once
  unchecked (catalog rows don't — they can be re-added later from suggestions).
- **Edit subtitle removed.** `editSubtitle` is now `''` (and the `.sub` element is hidden in edit
  mode); the old "Checked benefits are on your card now… × to remove" line is gone.
- **Add-success banner simplified.** Shows just **"{card} is added to your dashboard."** (new string
  `addedToDash`); the in-banner "Open dashboard" link was removed (the header link still navigates).
  The "nothing added / already tracked" message (`addedNone`) still shows when 0 were added.
