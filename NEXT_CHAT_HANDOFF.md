# Next Chat Handoff - Credit Card Benefit Tracker

This document summarizes the current review findings and the recommended next feature:
clearer catalog freshness metadata plus a stale-catalog review reminder.

---

## 🔁 Handoff from the 2026-06-17 fix session (read this first)

A prior chat just fixed the `/exec` deployment bug and made small email/UI changes. Firsthand context that affects the review items below:

- **Repo state:** on `main` @ `8a7b3d9`, working tree clean, **local-only (no git remote)**. `node verify.js` = **69 passed, 0 failed**. The `/exec` "unable to open the file" bug is **FIXED** (see `HANDOFF.md` top → "✅ FIXED 2026-06-17").

- **✅ Review #3 (NUL byte) is CONFIRMED — do this first, it's trivial.** There is exactly **one** NUL byte in `Code.gs`, in `dedupKey_()` at **line 1158**: the separator that looks like `+ ' ' +` is actually `+ '\x00' +`. It makes `file Code.gs` report `data` and forces `grep -a` / `rg --text` all session. `dedupKey_` is **transient** (used only within `addBenefits`/`updateCard` for in-call dedup at ~`:1118`/`:1127`, never persisted), so changing the separator value is **safe — no stored keys to migrate**. Replace with a visible separator (e.g. `' | '` or `JSON.stringify([card, benefit])`).

- **⚠️ Review #2 — do NOT blindly revert `CONFIG.WEBAPP_URL` to `''`.** It is hard-coded **on purpose**: it was set this session to fix a real production bug where every reminder-email link broke (the versioned `/exec` deployment's serving state corrupted, and a trigger-context `getService().getUrl()` could resolve to a stale deployment). For **this user's personal deployment the pin MUST stay.** The review's "use `''`" advice applies **only to a separate open-source/distribution copy** — if you make one, strip it there and document it; don't regress the working repo. See `PITFALLS.md` #15. (Also: if you ever create a brand-new deployment, you must update `WEBAPP_URL` to the new `/exec`.)

- **Read `PITFALLS.md` before engine changes.** Especially **#2** (setup is idempotent; any sheet migration must *append* columns and *preserve* existing values — this directly governs the Catalog schema migration the feature needs), **#9** (anniversary basis is derived from `CATALOG` by benefit name = exactly review #4), and **#15/#16** (added this session: WEBAPP_URL pinning; trailing-`_` functions don't show in the Run dropdown).

- **Workflow constraints:** work on a **new branch**; keep `node verify.js` green and **extend it** for any new pure logic; keep `STRINGS` en/zh **symmetric** (verify checks counts); security model stays **execute as me / Only myself** with `requireAuth_` on every server fn and **no side-effecting GET**; a code change only goes live via **Manage deployments → Edit → New version** (not a new deployment). The user replies in **Chinese** (keep deployment steps / technical terms in English) and likes to see a **diff per major step**.

- **Scope note:** the review is large — confirm with the user which slice to take before implementing. The review's own "Suggested Implementation Order" is a good spine. Quick, independent, low-risk wins: NUL byte (#3), edit-mode dedup (#5), and the `Clear all` guard (UI #1). The headline feature (catalog freshness + `reviewStaleCatalog()`) needs the header-migration helper built first.

---

## Current State

- App type: Google Apps Script web app backed by Google Sheets.
- Main files:
  - `Code.gs` - server logic, sheet schema, catalog seed data, reminders, web app routes.
  - `Index.html` - dashboard.
  - `AddCards.html` - add/edit card wizard.
  - `Confirm.html` - email action confirmation page.
  - `verify.js` - local sanity harness.
- Existing local test status: `node verify.js` passes with `69 passed, 0 failed`.
- Current built-in catalog has 4 cards, each with `lastVerified: '2026-06'`.
- Current Add Card page already shows a small line like `Benefits as of 2026-06. Verify current terms with your issuer.` via `lastVerified`.

## Highest Priority Issues

1. Security model mismatch for shared deployments.
   - In `Code.gs`, `isAuthorized_()` returns true whenever `AUTHORIZED_EMAILS` is empty.
   - This is fine for the intended private deployment, `Execute as me` plus `Only myself`.
   - It is unsafe if someone follows the docs' optional `Anyone + TOKEN` path, because dashboard `google.script.run` mutations do not carry or validate a token.
   - Recommended action: document private deployment as the only supported default, or add real token/identity checks to all state-changing server functions before supporting `Anyone`.

2. `CONFIG.WEBAPP_URL` is hard-coded to a deployed URL.
   - Good for the current personal deployment, but bad for sharing/open-sourcing.
   - Recommended action: use `''` or a placeholder in distributed code, and keep the user's personal URL only in their private copy.

3. `Code.gs` contains a real NUL byte in `dedupKey_()`.
   - `file Code.gs` identifies it as `data`, and `rg` treats it like binary unless `--text` is used.
   - Recommended action: replace the literal NUL separator with a visible safe separator, for example `'\u0000'`, or use `JSON.stringify([cardKey, benefitKey])`.

4. Anniversary reset basis is fragile.
   - `periodBasis: 'anniversary'` exists in the hard-coded `CATALOG`, but it is not written into the editable `Catalog` sheet.
   - Runtime derives period basis by matching card + benefit name against the hard-coded `CATALOG`.
   - If the user renames a benefit in the sheet or wizard, anniversary behavior can fall back to calendar behavior.
   - Recommended action: add a `PeriodBasis` column to `Catalog` and ideally persist it into `Benefits`.

5. `updateCard()` can create duplicate benefits.
   - Add flow has dedup logic, but edit flow does not initialize dedup from existing rows.
   - A user can add a new row with the same benefit name as an existing row in edit mode.
   - Recommended action: dedupe incoming edit rows against existing card benefits by normalized card + benefit name.

6. `setupCards()` and `setupCatalog()` do not migrate existing sheets.
   - They return early if the sheet exists, which protects user edits but leaves stale headers or old semantics in place.
   - This has already caused issues around `OpenDate` vs `Anniversary`.
   - Recommended action: add safe header migration that appends missing columns and preserves existing values.

## Product/UI Improvements

1. Edit mode `Clear all` is risky.
   - In edit mode, clearing all checks and saving removes all benefits for that card.
   - Recommended action: hide `Clear all` in edit mode, rename it, or add a confirmation that lists what will be removed.

2. Mobile dashboard layout can get cramped.
   - `.ben` rows stay horizontal even when action buttons wrap.
   - Recommended action: add a small-screen media query that stacks benefit info and actions vertically.

3. Empty dashboard state is minimal.
   - If there are no benefits, show a friendly empty state with an Add Cards CTA.

## Requested Feature: Catalog Freshness Metadata + Stale Review Reminder

The user likes this direction:

- Make `SourceUrl` and `LastVerified` clearer in `Catalog`.
- Show freshness more visibly in Add/Edit card pages.
- Add a periodic reminder to review stale catalog entries.
- Do not auto-overwrite benefits without user confirmation.

### Recommended Design

Keep this semi-automatic, not fully automatic.

Reason: credit-card terms pages contain footnotes, enrollment requirements, targeted offers, and account-specific differences. Fully automatic scraping or AI updates could silently corrupt the user's tracker. The safer workflow is:

1. Detect stale catalog entries.
2. Email or show a review list.
3. Let the user manually verify and update.
4. Only then apply changes to `Catalog`, `Cards`, or tracked `Benefits`.

### Schema Proposal

Minimal migration, append columns instead of reordering existing ones.

Current `Catalog` headers:

```text
Card, LastVerified, Benefit, Amount, Category, Reset, ReminderDays
```

Proposed `Catalog` headers:

```text
Card, LastVerified, Benefit, Amount, Category, Reset, ReminderDays, SourceUrl, PeriodBasis, Notes
```

Field meanings:

- `LastVerified`: `YYYY-MM` or `YYYY-MM-DD`; row-level is okay even if repeated for all benefits on a card.
- `SourceUrl`: issuer or official terms page URL for this benefit/card.
- `PeriodBasis`: `calendar` or `anniversary`; default `calendar`.
- `Notes`: optional human notes, for example enrollment caveats or eligible merchants.

Optional future `Cards` sheet columns for annual fee freshness:

```text
AnnualFeeLastVerified, AnnualFeeSourceUrl, Notes
```

This matters because annual fees change separately from benefits.

### Code Changes To Make

1. Update constants in `Code.gs`.
   - Add new catalog columns to `CATALOG_HEADERS`.
   - Add `sourceUrl`, `periodBasis`, and optionally `notes` fields to built-in `CATALOG` entries.
   - Keep defaults for old rows:
     - `sourceUrl: ''`
     - `periodBasis: 'calendar'`
     - `notes: ''`

2. Add safe catalog migration.
   - Do not return early from `setupCatalog()` before checking headers.
   - If `Catalog` exists, append any missing headers to the right.
   - Preserve all user-edited values.
   - Consider adding a helper like `ensureHeaders_(sheet, headers)`.

3. Update `getCatalogData_()`.
   - Read by header name, not hard-coded column positions.
   - Return each benefit with `lastVerified`, `sourceUrl`, `periodBasis`, `notes`.
   - If only card-level `lastVerified` exists, propagate it to each benefit.

4. Persist `PeriodBasis` more reliably.
   - Best option: add a `PeriodBasis` column to `Benefits`.
   - Migration: append missing `Benefits` header and default old rows from catalog match or `calendar`.
   - Update `readRows_()`, `addBenefits()`, and `updateCard()` to read/write it.
   - This removes the fragile dependency on exact benefit names in hard-coded `CATALOG`.

5. Update Add/Edit UI.
   - In `AddCards.html`, show a stronger freshness line when a card is selected:
     - `Benefits verified as of 2026-06`
     - If available, include a `Source` link.
     - If stale, show a small warning like `Review recommended`.
   - In edit mode, show the same freshness note for catalog suggestions/current card context.

6. Add stale catalog reminder.
   - Add config:

```js
CATALOG_REVIEW_AFTER_MONTHS: 6,
CATALOG_REVIEW_HOUR: 10
```

   - Add function:

```js
function reviewStaleCatalog() { ... }
```

   - It should:
     - Read `Catalog`.
     - Parse `LastVerified`.
     - Find rows/cards older than `CATALOG_REVIEW_AFTER_MONTHS`.
     - Email `CONFIG.EMAIL` a compact list grouped by card.
     - Include `SourceUrl` links when available.
     - Never mutate benefits automatically.

   - In `setup()`, create a monthly trigger for `reviewStaleCatalog`, or expose a separate `setupCatalogReviewTrigger()` to avoid surprising users.

7. Add an optional dashboard/admin view later.
   - A small `?view=catalogReview` page could list stale entries with source links.
   - This is lower priority than the email reminder.

### Suggested Implementation Order

1. Fix the NUL byte in `Code.gs`.
2. Add header migration helper.
3. Expand `Catalog` schema with appended columns.
4. Update `getCatalogData_()` to use header-based reads.
5. Show `SourceUrl` and clearer `LastVerified` text in `AddCards.html`.
6. Add `reviewStaleCatalog()` and trigger setup.
7. Add/adjust tests in `verify.js`.
8. Then consider persisting `PeriodBasis` into `Benefits`.

## Tests To Add

Update `verify.js` with:

- Assert `Code.gs` contains no literal NUL byte.
- Assert old 7-column `Catalog` rows still parse.
- Assert new `SourceUrl`, `PeriodBasis`, and `Notes` columns parse when present.
- Assert stale date parsing works for `YYYY-MM` and `YYYY-MM-DD`.
- Assert `updateCard()` rejects or skips duplicate benefit names.
- Assert anniversary-basis benefits keep `PeriodBasis` after add/edit.

## Non-Goals For Now

- Do not build a full automatic credit-card terms scraper as the first step.
- Do not auto-apply issuer changes to existing tracked `Benefits`.
- Do not mix this with a reward optimizer. That is a separate product with much higher data-maintenance cost.

## Practical Notes For The Next Chat

- Be careful with existing user sheets. `setup()` is intentionally idempotent; migrations should append missing columns and preserve data.
- Re-run `node verify.js` after changes.
- If deploying to Apps Script, remember that code changes require a new deployment version.
- For open-sourcing or sharing, remove personal deployment values from `CONFIG.WEBAPP_URL`.
