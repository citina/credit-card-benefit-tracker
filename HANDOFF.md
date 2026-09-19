# Handoff — Credit Card Benefit Tracker

**Single entry point for a fresh chat/session.** Read this first; the rest as needed:
- **`BUILD_SPEC.md`** — full design, security model, data model, decisions (the design bible).
- **`SETUP.md`** — step-by-step deployment.
- **`PITFALLS.md`** — non-obvious traps (踩过的坑). **Read before changing the engine.**
- **`Code.gs` / `Index.html` / `Confirm.html` / `AddCards.html`** — the app. **`verify.js`** — local test harness (NOT deployed).

_Snapshot: 2026-06-17. Public on GitHub since 2026-09-19: `citina/credit-card-benefit-tracker`._

## ✅ FIXED 2026-06-17 — `/exec` web-app links showed Google Drive "unable to open the file"

**Was:** every reminder-email link (Done / Snooze / Open dashboard) **and** the bare `/exec` dashboard showed Google's *"Sorry, unable to open the file at this time."*

**Root cause:** the versioned `/exec` deployment (`<old-deployment-id>`) was in a **corrupted serving state** — `doGet` ran and logged "completed", but Google's output/redirect layer failed to serve it. Not a repo code bug (`/dev` head worked; `verify.js` green). Confirmed by: clicking `/exec` produced a *fresh, completed* `doGet` execution (request reached the server) yet the browser still errored, and it failed in **incognito** too (ruled out browser session / multi-account).

**Fix:** **created a NEW deployment** (Deploy → New deployment → Web app → Execute as **Me** / **Only myself**) → fresh URL `<new-deployment-id>/exec` opened cleanly. Then **pinned that URL into `CONFIG.WEBAPP_URL`** and routed all 5 URL call sites through a new `webAppUrl_()` helper (`CONFIG.WEBAPP_URL || ScriptApp.getService().getUrl()`), so trigger-generated email links no longer depend on `getService().getUrl()` (which can resolve to a stale/broken deployment). See PITFALLS #15.

**⚠️ Maintenance:** if you ever **create another new deployment** (new `AKfycb…/exec` URL), you **must** update the `WEBAPP_URL` **Script Property** to match (it moved out of `CONFIG` when the repo went public — PITFALLS #15), or email links point at the old one. Editing the *existing* deployment to a **New version** keeps the URL — that's the normal path.

## What it is
A credit-card recurring-benefit tracker on **Google Apps Script + Sheets + Gmail**, deployed as a private web app (**execute as me / access "Only myself"**). It solves one problem: *forgetting to use use-it-or-lose-it card credits before they expire.* Daily email reminder + a web dashboard + an in-app add/edit-cards wizard. Bilingual en/zh (`CONFIG.LANG`). Data lives in the owner's own Google Sheet; status is **derived, not stored** (a benefit is "done" when `LastDonePeriod == periodKey_`, so it auto-resets at period boundaries — no reset job).

## Current state — built & working ✅
- **Daily reminder** (`sendReminders`, 9am local): period-driven (start-of-period + near-expiry nudges). Email Done/Snooze links open a **confirm page** (no silent GET writes). Each row shows the `$` amount (via `displayAmount_`, which `$`-prefixes bare numbers) and `Nd left · expires <date>`. **Cadence** is global via `CONFIG.REMINDER_CADENCE` (`'minimal'` = two nudges | `'persistent'` = re-nudge every `REMINDER_REPEAT_DAYS` in the expiry window until done/snoozed). `previewReminders()` is a read-only editor diagnostic (trigger status + each benefit's next-reminder date; no email, no writes).
- **Dashboard** (`Index.html`): benefits grouped by card; Mark done / Snooze (two-step: pick a date / skip this period) / Undo / Un-snooze; within-card sort, done pinned to the bottom; days-left + expiry or "resets &lt;date&gt;". ⋮ menu per card (Edit / Remove). (No top summary-stats panel or subtitle — removed 2026-06-17 to declutter.)
- **Add/Edit cards wizard** (`AddCards.html`): pick a card → its catalog benefits (opt-in, unchecked) → tick/edit/add → write (auth + lock + dedup). Edit updates in place (preserves done/snooze); remove by unchecking.
- **Annual-fee value bar** (per card): realized value / annual fee, accumulated over the **cardmember anniversary year**, lazy reset (no cron). `$`-amounts only (`parseAmount_`). Shows when `fee>0` AND the card has ≥1 parseable-$ benefit. Card-level **manual seed** ("already used this year $") for people who start mid-year.
- **Anniversary-year resets**: benefits flagged `anniversary` in `CATALOG` (CSP **Hotel $100**, CSR **Annual travel $300**) reset on the card anniversary, not Jan 1 — affects done-status, reminders, expiry, snooze. Basis is **derived from CATALOG by name** (no per-benefit UI). Card **anniversary** is MM-DD (month/day, no year); **required when the card has a fee**.
- **Catalog** (CSP / Amex Gold / Amex Platinum / CSR, verified 2026-06) ships in code, seeded into an editable `Catalog` sheet (user edits win).
- **Catalog freshness**: the wizard shows a `Last verified: <Mon YYYY>` line per card + an optional **Source** link + a **Review recommended** flag when older than `CONFIG.CATALOG_REVIEW_AFTER_MONTHS` (6). `reviewStaleCatalog()` emails a monthly review list of stale cards (read-only — never auto-edits benefits). `SourceUrl`/`Notes` seed blank for the user to fill; `PeriodBasis` seeds from the constant.
- **Duplicate-name guard**: the wizard blocks save when two checked rows share a benefit name (asks to rename); `updateCard` also dedups server-side (two-pass).

## Data model (sheets)
- **`Benefits`** (12 cols): `ID, Card, Benefit, Amount, Category, Reset, ReminderDays, LastDonePeriod, LastReminded, SnoozeUntil, RealizedValue, RealizedPeriod`.
- **`Cards`** (5 cols): `Card, AnnualFee, Anniversary (MM-DD), RealizedSeed, RealizedSeedPeriod`.
- **`Catalog`** (10 cols): `Card, LastVerified, Benefit, Amount, Category, Reset, ReminderDays, SourceUrl, PeriodBasis, Notes`. `getCatalogData_` reads it **by header name** (not column position); `ensureHeaders_` append-migrates older 7-col sheets. `LastVerified` is plain-text (`@`) on fresh installs; `verifiedKey_` normalizes any coerced-Date cell on read.

## Constraints to preserve (don't break — see PITFALLS for why)
- Deploy stays **execute as me / access "Only myself"**; never "Anyone". Every server fn calls `requireAuth_()`. **No new external/runtime network calls.**
- **No side-effecting GET** — writes go through `google.script.run` + `LockService`.
- **Plain-text columns**: `LastDonePeriod`, `RealizedPeriod`, `Anniversary`, `RealizedSeedPeriod`, and Catalog `LastVerified` are `setNumberFormat('@')` (Sheets coerces dates otherwise; `verifiedKey_` also normalizes coerced cells on read).
- **i18n**: every user-facing string in `STRINGS` en + zh, kept symmetric (verify checks counts).

## Verify & deploy
- **Verify:** `node verify.js` from the repo root → exit 0 = green (parses HTML inline JS + runs the pure logic under GAS stubs). **Extend it when you add logic.**
- **Deploy:** paste `Code.gs`, `Index`, `Confirm`, `AddCards` into the Apps Script editor (HTML files named without extension; `verify.js` + docs are local-only, not deployed). Run **`setup()`** once (creates/migrates `Benefits` + `Cards` + `Catalog`; idempotent — **delete a stale `Cards`/`Catalog` tab first**, see PITFALLS #2). **Manage deployments → Edit → New version.** Set the project **time zone**.
- Re-deploying after this feature: re-paste `Code.gs` / `Index` / `AddCards` (`Confirm` unchanged) + re-run `setup()`.

## Next steps / backlog
1. **Open-source it — mostly DONE 2026-09-19.** Public repo `citina/credit-card-benefit-tracker`; `README.md` (overview, security model, quick start → `SETUP.md`) + MIT `LICENSE`; the pinned `/exec` URL moved from `CONFIG.WEBAPP_URL` to the `WEBAPP_URL` Script Property; git history scrubbed of deployment URLs and commit email switched to the GitHub noreply address before the first push. _Remaining:_ a copy-this-Sheet template link or a `clasp` workflow so non-coders can deploy.
2. **Partial-use benefits.** CSR DoorDash $25 = $5 + 2×$10; marking done counts the **full** $25 toward the bar (over-counts). Options: split into per-sub-credit rows, or a "used X of Y" multi-use model (new storage + UI).
2b. **Conditional / spend-gated benefits.** Some perks unlock only after annual spend (e.g. CSR's extra $500 The Edit credit after $75k/yr) or are non-$ status perks. The tracker has **no spend/transaction data** so it can't auto-unlock these. Workable today: add such a credit only once unlocked, with the caveat in the new `Notes` column ("after $75k spend"). Non-$ perks (status, free night, points boost) are out of scope. Possible later: a `Notes`-surfacing or an "unlocked?" toggle.
3. **Catalog freshness — BUILT 2026-06-19** (freshness line + Source link + stale flag + `reviewStaleCatalog()` monthly email; semi-automatic, never auto-edits). _Remaining:_ (a) **persist `PeriodBasis` into `Benefits`** so a renamed benefit keeps its anniversary basis (today it's re-derived from `CATALOG` by name — review #4/#9); (b) data correction: CSR **The Edit** ($250 semiannual in code; from 2026 both $250s are usable anytime in the year); (c) optional Cards-sheet annual-fee freshness columns (`AnnualFeeLastVerified` / `AnnualFeeSourceUrl`).
4. **Dashboard UI polish (review).** (a) mobile: `.ben` rows don't stack on narrow screens — add a small-screen media query; (b) friendly empty state + Add-Cards CTA when there are no benefits.
5. **"Which card to use" reward optimizer — SHELVED (too much upkeep).** Needs per-card earning multipliers + active targeted offers (Amex/Chase Offers; no API → manual entry). Good AI fit (Claude via `UrlFetchApp`) but a **separate concern** from the reminder tool — recommended to do in chat / a Claude Project, not bolt onto this app. If ever built: its own multipliers + offers sheets + a dashboard chat box.
6. **Accepted caveats (not bugs, see PITFALLS):** a calendar-annual benefit on a non-January card can be counted twice/zero within a membership window; annual fee isn't versioned across years.
