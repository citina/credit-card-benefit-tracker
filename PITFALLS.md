# 踩过的坑 / Pitfalls

Non-obvious traps in this codebase. **Read before touching `Code.gs` or the sheets.** Each one cost real debugging time at least once.

## Sheets & data

1. **Period keys must be plain-text or Sheets eats them.** `LastDonePeriod` (e.g. `2026-06`), `RealizedPeriod`, `Anniversary` (`MM-DD`), and `RealizedSeedPeriod` are written **after `setNumberFormat('@')`**. Otherwise Sheets coerces `2026-06` / `06-06` into a **Date**, which then never matches `periodKey_()` on read → the benefit looks **un-done after reload**. (Annual `2026` survives by luck; monthly and MM-DD break.) `setup()` re-stamps these columns plain-text on every run.

2. **`setup()` is idempotent — it does NOT reset an existing sheet.** `setupCards()` / `setupCatalog()` return early if the sheet already exists (to protect user edits). So a **stale sheet from earlier testing keeps old values.** This actually bit us: after renaming `OpenDate` → `Anniversary`, an old full-date open-date surfaced as a phantom **"Jan 20"** anniversary on Amex Platinum. **Fix: delete the `Cards` (or `Catalog`) tab and re-run `setup()`, or clear the offending cell.** Do this once before any real go-live if a test tab exists.

3. **Adding a `Benefits` column means widening every write.** Reads/writes use `HEADERS.length`. When you add a column, update `COL`, `HEADERS`, `seedExamples_`, **and** the `newRows.push([...])` in both `addBenefits` and `updateCard` to the new width — or rows misalign. (New sheets default to 26 columns, so reads past the old width return blank instead of throwing — the bug hides.)

## Time

4. **All day/period math in the script timezone.** Use `Utilities.formatDate(..., Session.getScriptTimeZone())` + the `dayNumber_` helper, never raw `getTime()` UTC ms. **Set the Apps Script project time zone** (Project Settings) or period boundaries and the 9am send drift by a day around DST/midnight. Helper Dates are noon-anchored (`+12h`) so tz formatting never slips a day.

## Security model

5. **"Execute as me / Only myself" is the real guard — not the token.** Sharing the web-app link does **not** let others in; Google blocks any non-owner account. The app runs as the owner, so a visitor never touches the Sheet directly. **Sharing model = share the CODE; each person deploys their own private copy.** The `AUTHORIZED_EMAILS` allowlist is only enforceable on Google **Workspace**, not personal `@gmail` (the visitor's email isn't exposed when executing as the owner). `TOKEN` is defense-in-depth, never the boundary.

6. **No side-effecting GET.** Email Done/Snooze links open a **confirm page that writes nothing**; the write happens via `google.script.run` on an explicit tap. If `doGet` ever mutates on its own, email link prefetchers / scanners will silently fire it.

## Logic

7. **Realized accumulation must be idempotent.** done/undo guard on the *actual* not-done→done transition (`isDone_` on the **old** `lastDonePeriod`, read before overwriting). Without the guard, re-tapping "done" double-counts the bar.

8. **`parseAmount_` is deliberately strict.** Counts `$`-amounts and bare numbers only: `$12.95`→12.95, `10`→10, but `"12 visits"` must **NOT** become `12`, and `"Unlimited"`→null. It takes the **first** `$` in a multi-amount string (`"$5 + $10"`→5) — the catalog uses display totals (`$25`) to dodge this.

9. **Anniversary basis is issuer-fixed, derived from `CATALOG` by name.** `benefitPeriodBasis_` matches card+benefit against the constant; a **renamed** benefit or a manual-add loses the `anniversary` flag and falls back to calendar. (Chosen over a stored column / per-benefit toggle — the issuer decides this, not the user.)

10. **A calendar-annual benefit on a non-January card is inherently lumpy.** Its Jan-1 reset doesn't line up with the membership-year bar window, so it can be counted twice (or zero) in one window. **NOT fixable by setting the anniversary** — those benefits reset Jan 1 by issuer rule; only genuinely-anniversary benefits align. Accepted, not a bug.

## Build / deploy

11. **`verify.js` is not part of the app.** It's a local Node harness (GAS-stubbed). Don't paste it into the Apps Script editor. Run `node verify.js` (exit 0) before deploying.

12. **Re-deploy a NEW version after any code change** (Manage deployments → Edit → New version), or the live dashboard + email links keep running old code. **Edit the *existing* deployment → New version** (keeps the same `/exec` URL); do **not** spin up a brand-new deployment for a routine update — that mints a different `/exec` URL and would desync `CONFIG.WEBAPP_URL` (#15).

13. **STRINGS en/zh must stay symmetric.** `verify.js` checks that the key counts match; add every new string to **both** language blocks.

14. **The 4 example seed rows are demo data.** `seedExamples_` seeds them on first setup (incl. a non-$ "Priority Pass / Unlimited") — replace with real cards via the wizard. The **`CATALOG` itself has only $ credits** (lounge / Global Entry / multipliers were deliberately excluded), so every real catalog card shows a progress bar.

15. **Web-app links are pinned to `CONFIG.WEBAPP_URL`, not `getService().getUrl()`.** A corrupted versioned `/exec` deployment once served Google's *"unable to open the file"* even though `doGet` completed (see HANDOFF, fixed 2026-06-17). The fix was a new deployment **plus** hard-pinning its `/exec` into `CONFIG.WEBAPP_URL`; `webAppUrl_()` returns that (falling back to `getService().getUrl()` only if blank). **From a time-trigger context `getService().getUrl()` can resolve to the wrong/stale deployment**, so don't reintroduce it for email links. **If you ever create a NEW deployment, update `CONFIG.WEBAPP_URL` to the new `/exec`** or every email link breaks. To diagnose this class of bug: click the link, check **Executions** (a completed `doGet` + a browser Drive error = serving-layer, not code), and retest in **incognito** to rule out browser session.

16. **Functions named with a trailing `_` don't appear in the editor's Run dropdown** (Apps Script treats `_` as private). A throwaway test function you want to run manually must be named without the trailing underscore (e.g. `testSendReminder`, not `testSendReminder_`).

## Catalog freshness (added 2026-06-19)

17. **`Catalog.LastVerified` coerces to a Date — read it through `verifiedKey_`, never `String(cell)`.** Like #1, Sheets turns `2026-06` into a Date unless the column is plain-text, and a stored Date stringifies as `"Mon Jun 01 2026 00:00:00 GMT-0700…"` — which both looks broken in the wizard **and** silently defeats stale detection (`monthsSinceVerified_`'s `YYYY-MM` regex never matches → "never stale" → no review email). `verifiedKey_` normalizes string-or-Date → `YYYY-MM(-DD)` on read; `verifiedLabel_` renders the friendly "Jun 2026"; `setupCatalog` stamps the column `@` on fresh installs. (Date detection uses `Object.prototype.toString.call`, **not** `instanceof Date` — realm-safe for the verify vm.)

18. **`getCatalogData_` reads the Catalog by HEADER NAME, not column position.** New columns are appended via `ensureHeaders_` (append-only, preserves data — #2). So **don't** index Catalog rows by a hard-coded position, and a column reorder by the user is harmless. Old 7-col sheets still parse (missing columns read as defaults: `periodBasis`→`calendar`, `sourceUrl`/`notes`→`''`).

19. **Reminder cadence is global in `CONFIG.REMINDER_CADENCE`** (`'minimal'` | `'persistent'`). `shouldRemind_` / `nextReminder*_` take optional `(cadence, repeatDays)` trailing args defaulting from CONFIG — production callers pass nothing (zero change), verify pins both modes. `persistent` re-nudges every `REMINDER_REPEAT_DAYS` inside the near-expiry window; `LastReminded` still dedups so it can't double-fire in a day.
