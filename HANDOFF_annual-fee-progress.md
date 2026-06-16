# Handoff — annual fee + realized-value progress bar

A self-contained brief for a fresh Claude Code session. **Build the per-card annual-fee value
progress bar.** Each card shows **realized value / annual fee** so the owner can see whether the card
has paid for itself.

> **The one decision that shapes everything:** realized value **accumulates over the annual-fee
> period — the cardmember _anniversary year_, counted from the card's open date — and resets at each
> anniversary, NOT on Jan 1.** The annual fee is billed once per cardmember year, so "has it paid for
> itself" is measured over that same year. (Agreed with the user 2026-06-16.)

## Read first (in order)
`STATUS.md` → `BUILD_SPEC.md` → `Code.gs` (engine) → `HANDOFF_followups.md`. This is **backlog #2**
there. **Also read backlog #3 (anniversary reset)** — it shares the new `Cards` sheet + the card
**open date**, and the same "anniversary-year" math. This task builds that anniversary math *for the
fee period only*; #3 (reusing it to fix each benefit's own reset) stays separate.

## What this app is (1 paragraph)
A credit-card recurring-benefit tracker on Google Apps Script + Sheets + Gmail, deployed private
(execute as me / access "Only myself"). Data in a `Benefits` sheet. Daily `sendReminders()` emails
what's still to use; a web dashboard (`doGet` → `Index.html`) shows status; an in-app wizard
(`AddCards.html`) adds/edits cards. Status is **derived, not stored** — a benefit is "done" when
`LastDonePeriod == periodKey_(reset, now)`, which auto-resets at period boundaries (no reset job).
Bilingual via `CONFIG.LANG` (`en`/`zh`), every string in `STRINGS` (keep en/zh symmetric).

---

## Scope

**In scope**
1. Store a per-card **annual fee** + **open date** (new `Cards` sheet).
2. Parse a numeric value out of the free-text `Amount` (`parseAmount_`).
3. Accumulate **realized value per annual-fee period** on a card's benefits (two new Benefits
   columns), incrementing on `markDone`, decrementing on `undo`, **lazily reset at the anniversary**.
4. Render a **progress bar** per card (realized / fee) on the dashboard.
5. Let the user set the fee + open date in **add/edit card**.
6. Extend `verify.js` with pure-logic asserts.

**Out of scope (do NOT build here)**
- Changing each *benefit's own* reset from calendar to anniversary — that's backlog **#3**. This task
  does **not** touch `periodKey_` / `periodStartDayNumber_` / `periodEndDayNumber_` /
  `periodRefreshDate_`; benefits keep resetting on the calendar as today. We only add a *separate*
  annual-fee-period calculation used for the realized-value accumulator + the bar.
- Partial-use benefits (#4), catalog freshness (#5).

---

## Design (agreed — implement this)

### 1. `Cards` sheet (new)
Columns: `Card | AnnualFee | OpenDate`.
- `setup()` creates + seeds it (idempotent, like `setupCatalog()`): one row per `CATALOG` card,
  `AnnualFee` = catalog default (below), `OpenDate` left **blank** for the user to fill.
- A reader `getCardMeta_(card)` → `{ annualFee: Number||0, openDate: 'yyyy-MM-dd'||'' }`. Build a
  map of all cards once per dashboard render (don't read per row).
- Default annual fees to seed into `CATALOG` (add an `annualFee` field per card) — **2026,
  approximate, the wizard already shows a "verify with issuer" note**: CSP **$95**, Amex Gold
  **$325**, Amex Platinum **$695**, CSR **$795**.

### 2. `parseAmount_(s)` — numeric value of a free-text amount
Rule: a dollar value only. If the string contains `$`, take the number after it; else if the whole
string is a bare number (matches `fmtAmount`'s `^\d+(\.\d+)?$`), take it; else `null`.
- `$12.95`→12.95, `$300`→300, `$25`→25, `10`→10, `Unlimited`→null, `12 visits`→**null** (no `$`,
  not a bare number — must NOT become 12). `null` amounts are excluded from accumulation.

### 3. Two new `Benefits` columns
Append (keep existing 1–10):
- `11 RealizedValue` (number) — accumulated realized $ in the period named by the next column.
- `12 RealizedPeriod` (text/number) — the **annual-fee-period key** that value belongs to: the
  period's **start year** (an integer, see below). Keep it plain-text-safe like `LastDonePeriod`.

Update: `COL` (add `REALIZED_VALUE: 11, REALIZED_PERIOD: 12`), `HEADERS` (+`'RealizedValue',
'RealizedPeriod'`), `seedExamples_` (two trailing `''` per row, or `0`/`''`), `readRows_` (read both;
`realizedValue: Number(...)||0`, `realizedPeriod: String(...)`).

### 4. Annual-fee-period math (the crux) — keep it PURE and testable
The period runs from the card's open month/day this-or-last year to the next anniversary. Identify
it by its **start year** (integer):

```
function annualFeePeriodStartYear_(openDate, now) {
  // openDate '' or unparseable → fall back to calendar year (om=1, od=1) so behavior is predictable.
  const tz = Session.getScriptTimeZone();
  const y  = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const m  = Number(Utilities.formatDate(now, tz, 'MM'));
  const d  = Number(Utilities.formatDate(now, tz, 'dd'));
  const md = parseMonthDay_(openDate);            // {om,od} or {om:1,od:1} on miss
  const past = (m > md.om) || (m === md.om && d >= md.od);  // today on/after this year's anniversary?
  return past ? y : y - 1;
}
```
- `RealizedPeriod` stores this start year. **Lazy reset, no cron:** on read, a benefit's
  `RealizedValue` counts only if `realizedPeriod === annualFeePeriodStartYear_(openDate, now)`;
  otherwise it's stale → treat as 0. This fits the app's "derived, no reset job" philosophy.
- Also add `annualFeeResetDate_(openDate, now)` → the next anniversary `Date` (start year + 1 at
  om/od), for showing "resets <date>" under the bar. Leap-day 2-29 opens: approximate to 2-28.

### 5. Accumulator — also a PURE helper (so it's testable without `new Date()`)
```
// Returns the new {value, period} after a done toggles a benefit from not-done → done.
function realizedAfterDone_(prevValue, prevPeriod, afYear, amount) {
  const base = (Number(prevPeriod) === afYear) ? (Number(prevValue) || 0) : 0;  // cross-period → reset
  const amt  = parseAmount_(amount);
  return { value: base + (amt == null ? 0 : amt), period: afYear };
}
// And the undo counterpart: only subtract if same period; floor at 0.
```
Wire into `applyAction_` (the single write path):
- **done:** compute `wasDone = isDone_(row, now)` from the row's *old* `lastDonePeriod`. Only if
  `!wasDone`: `{value,period} = realizedAfterDone_(row.realizedValue, row.realizedPeriod, afYear,
  row.amount)` → write cols 11/12. Then set `LastDonePeriod` as today (existing logic). The
  `!wasDone` guard makes re-tapping done **idempotent** (no double-count).
- **undo:** only if `wasDone` and `row.realizedPeriod === afYear`: subtract `parseAmount_(row.amount)`
  (floor 0), write col 11. Then clear `LastDonePeriod` (existing).
- A monthly credit done once per calendar month accumulates ~12× over the fee year — correct, that's
  the point. `undo` only ever reverses the *current* period's done (matches today's undo semantics).

### 6. Dashboard (`buildDashboardData_` + `Index.html`)
- Per card add: `annualFee`, `realized` (Σ of its benefits' `realizedValue` where `realizedPeriod ==
  afYear`), `feeResetDate` (formatted via `fmtShortDate_`). Compute `afYear` once per card from its
  `getCardMeta_`.
- `Index.html`: under `.card-head`, render a progress bar **only when `annualFee > 0`**:
  e.g. `$210 / $695 · 30% · resets <date>`, a flat low-saturation fill bar matching the design
  (warm-white, 12px radius, no shadow). Clamp width to 100%; show overflow (e.g. ">100%") gracefully.

### 7. Add/Edit card UI (`AddCards.html` + server)
- Add a card-level **Annual fee** input and **Open date** (`<input type="date">`) near the card
  picker / edit header. Add mode: prefill fee from the catalog default; edit mode: prefill both from
  `getCardMeta_`. `getCardRows_` should also return the card's `{annualFee, openDate}`.
- Persist via a small server fn `setCardMeta(card, annualFee, openDate)` (auth + lock; upsert the
  `Cards` row), called alongside `addBenefits` / `updateCard`. Keep `OpenDate` as `yyyy-MM-dd`.

---

## Pitfalls / must-preserve
- **Idempotent accumulation** — guard done/undo on the *actual* not-done→done / done→not-done
  transition (`isDone_` on the old value), or counts drift on re-taps.
- **Plain-text** — `LastDonePeriod` stays `@`-formatted (existing). `RealizedPeriod` is a small int;
  if you ever store a date-like key instead, `@`-format it too.
- **Timezone** — all month/day/year reads via `Utilities.formatDate(…, Session.getScriptTimeZone())`,
  like the rest of the engine. Don't use raw UTC.
- **Missing `OpenDate`** — `annualFeePeriodStartYear_` falls back to calendar year. Decide whether to
  also nudge the user to set it (see open questions).
- **`Amount` parsing** — never treat "12 visits" as $12; only `$`-amounts or bare numbers count.
- **Locks + batched writes** — keep mutations under `LockService`; you're adding writes inside the
  existing locked `applyAction_`, that's fine.
- **i18n** — every new label in `STRINGS` en + zh (verify checks symmetry); surface via
  `uiStrings_` / `addUiStrings_`. No hardcoded English.
- **Security/constraints unchanged** — execute as me / Only myself; `requireAuth_()` on every server
  fn; no new external/runtime network calls; no side-effecting GET.

## Verify (extend `verify.js`)
Add pure-function asserts (these don't need `new Date()`):
- `parseAmount_`: `$12.95`→12.95, `$300`→300, `10`→10, `Unlimited`→null, `12 visits`→null.
- `annualFeePeriodStartYear_`: openDate `2024-06-06`, now `2026-06-16` → 2026; now `2026-03-01` →
  2025; openDate `''`, now `2026-xx` → 2026 (calendar fallback).
- `realizedAfterDone_`: same-period add (`prevPeriod==afYear`) accumulates; cross-period resets to
  the new amount; `Unlimited` amount adds 0.
- If feasible, a `buildDashboardData_`-style check of per-card `realized` using the fake-sheet
  harness already in `verify.js` (it stubs a sheet for `updateCard`/`getCardRows_`).
Keep STRINGS symmetry green and exit 0.

## Deploy (unchanged)
Paste `Code.gs` + the HTML files into the Apps Script editor. **Re-run `setup()` once** (it must
create/seed the new `Cards` sheet and the two new `Benefits` columns won't exist on old sheets — for
an already-seeded `Benefits`, add the two header cells + back-fill blanks, or document a one-time
migration). Then **Manage deployments → Edit → New version**. Set the project time zone.

## Open questions for the user (confirm before/while building)
1. **Missing open date:** silently fall back to calendar-year accumulation, or show "set your open
   date" on the card until provided? (Recommend: fall back + a subtle prompt.)
2. **Progress bar content/placement:** `$X / $Y · NN% · resets <date>` under the card name — ok? Show
   the bar for cards with **no** parseable-amount benefits (bar stuck near 0) or hide it?
3. **What counts as realized:** only `$`-amount benefits (current plan), or also let the user mark a
   non-$ benefit's "value" manually? (Recommend: $-only for v1.)
4. **Annual-fee defaults:** confirm CSP $95 / Gold $325 / Platinum $695 / CSR $795 for 2026, or leave
   `AnnualFee` blank and have the user enter it.
5. **Migration** of the existing deployed `Benefits` sheet (two new columns) — acceptable to just
   re-run `setup()` / hand-add the headers?
