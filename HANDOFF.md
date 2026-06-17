# Handoff — Credit Card Benefit Tracker

**Single entry point for a fresh chat/session.** Read this first; the rest as needed:
- **`BUILD_SPEC.md`** — full design, security model, data model, decisions (the design bible).
- **`SETUP.md`** — step-by-step deployment.
- **`PITFALLS.md`** — non-obvious traps (踩过的坑). **Read before changing the engine.**
- **`Code.gs` / `Index.html` / `Confirm.html` / `AddCards.html`** — the app. **`verify.js`** — local test harness (NOT deployed).

_Snapshot: 2026-06-16. Repo is local-only (no git remote)._

## What it is
A credit-card recurring-benefit tracker on **Google Apps Script + Sheets + Gmail**, deployed as a private web app (**execute as me / access "Only myself"**). It solves one problem: *forgetting to use use-it-or-lose-it card credits before they expire.* Daily email reminder + a web dashboard + an in-app add/edit-cards wizard. Bilingual en/zh (`CONFIG.LANG`). Data lives in the owner's own Google Sheet; status is **derived, not stored** (a benefit is "done" when `LastDonePeriod == periodKey_`, so it auto-resets at period boundaries — no reset job).

## Current state — built & working ✅
- **Daily reminder** (`sendReminders`, 9am local): period-driven (start-of-period + near-expiry nudges). Email Done/Snooze links open a **confirm page** (no silent GET writes).
- **Dashboard** (`Index.html`): benefits grouped by card; Mark done / Snooze (two-step: pick a date / skip this period) / Undo / Un-snooze; within-card sort, done pinned to the bottom; days-left + expiry or "resets &lt;date&gt;". ⋮ menu per card (Edit / Remove).
- **Add/Edit cards wizard** (`AddCards.html`): pick a card → its catalog benefits (opt-in, unchecked) → tick/edit/add → write (auth + lock + dedup). Edit updates in place (preserves done/snooze); remove by unchecking.
- **Annual-fee value bar** (per card): realized value / annual fee, accumulated over the **cardmember anniversary year**, lazy reset (no cron). `$`-amounts only (`parseAmount_`). Shows when `fee>0` AND the card has ≥1 parseable-$ benefit. Card-level **manual seed** ("already used this year $") for people who start mid-year.
- **Anniversary-year resets**: benefits flagged `anniversary` in `CATALOG` (CSP **Hotel $100**, CSR **Annual travel $300**) reset on the card anniversary, not Jan 1 — affects done-status, reminders, expiry, snooze. Basis is **derived from CATALOG by name** (no per-benefit UI). Card **anniversary** is MM-DD (month/day, no year); **required when the card has a fee**.
- **Catalog** (CSP / Amex Gold / Amex Platinum / CSR, verified 2026-06) ships in code, seeded into an editable `Catalog` sheet (user edits win).

## Data model (sheets)
- **`Benefits`** (12 cols): `ID, Card, Benefit, Amount, Category, Reset, ReminderDays, LastDonePeriod, LastReminded, SnoozeUntil, RealizedValue, RealizedPeriod`.
- **`Cards`** (5 cols): `Card, AnnualFee, Anniversary (MM-DD), RealizedSeed, RealizedSeedPeriod`.
- **`Catalog`** (7 cols): `Card, LastVerified, Benefit, Amount, Category, Reset, ReminderDays`.

## Constraints to preserve (don't break — see PITFALLS for why)
- Deploy stays **execute as me / access "Only myself"**; never "Anyone". Every server fn calls `requireAuth_()`. **No new external/runtime network calls.**
- **No side-effecting GET** — writes go through `google.script.run` + `LockService`.
- **Plain-text columns**: `LastDonePeriod`, `RealizedPeriod`, `Anniversary`, `RealizedSeedPeriod` are `setNumberFormat('@')` (Sheets coerces dates otherwise).
- **i18n**: every user-facing string in `STRINGS` en + zh, kept symmetric (verify checks counts).

## Verify & deploy
- **Verify:** `node verify.js` from the repo root → exit 0 = green (parses HTML inline JS + runs the pure logic under GAS stubs). **Extend it when you add logic.**
- **Deploy:** paste `Code.gs`, `Index`, `Confirm`, `AddCards` into the Apps Script editor (HTML files named without extension; `verify.js` + docs are local-only, not deployed). Run **`setup()`** once (creates/migrates `Benefits` + `Cards` + `Catalog`; idempotent — **delete a stale `Cards`/`Catalog` tab first**, see PITFALLS #2). **Manage deployments → Edit → New version.** Set the project **time zone**.
- Re-deploying after this feature: re-paste `Code.gs` / `Index` / `AddCards` (`Confirm` unchanged) + re-run `setup()`.

## Next steps / backlog
1. **Open-source it (user goal — make it set-up-able by others).** TODO: add a `README.md` (overview + quick start, point to `SETUP.md`); pick a license (e.g. MIT); confirm no personal data ships (`CONFIG.EMAIL` auto-derives from the runner; `TOKEN` is a placeholder; catalog/examples carry no personal info — OK); consider a copy-this-Sheet template link or a `clasp` workflow so non-coders can deploy; surface the security model (BUILD_SPEC) prominently for self-hosters. `SETUP.md` already covers install steps.
2. **Partial-use benefits.** CSR DoorDash $25 = $5 + 2×$10; marking done counts the **full** $25 toward the bar (over-counts). Options: split into per-sub-credit rows, or a "used X of Y" multi-use model (new storage + UI).
3. **Catalog freshness.** Issuer changes aren't flagged on already-tracked rows. Known stale: CSR **The Edit** ($250 semiannual in code; from 2026 both $250s are usable anytime in the year).
4. **"Which card to use" reward optimizer — SHELVED (too much upkeep).** Needs per-card earning multipliers + active targeted offers (Amex/Chase Offers; no API → manual entry). Good AI fit (Claude via `UrlFetchApp`) but a **separate concern** from the reminder tool — recommended to do in chat / a Claude Project, not bolt onto this app. If ever built: its own multipliers + offers sheets + a dashboard chat box.
5. **Accepted caveats (not bugs, see PITFALLS):** a calendar-annual benefit on a non-January card can be counted twice/zero within a membership window; annual fee isn't versioned across years.
