# Next Chat Handoff — Credit Card Benefit Tracker

**Single thing to read first, then `HANDOFF.md` (canonical state) / `PITFALLS.md` (踩过的坑) / `BUILD_SPEC.md` (design) / `SETUP.md` (deploy) as needed.** `verify.js` is a local Node harness (NOT deployed). The user replies in **Chinese** (keep deployment steps / technical terms in English) and likes a **diff per major step + `node verify.js` green before continuing**.

---

## 🔁 Handoff from the 2026-06-19 session (READ FIRST)

### Where things stand
- On branch **`feature/wizard-polish`** — **5 commits ahead of `main`, 0 behind, working tree clean**. Repo is **local-only (no remote)**. `node verify.js` = **117 passed, 0 failed**, `STRINGS` 104/104 symmetric.
- ⚠️ **NOT merged to main, and the user is mid-TEST.** They paused to deploy this whole batch and test it by hand. **First thing next session: ask whether the deploy + manual test passed.**
  - ✅ pass → `git checkout main && git merge --ff-only feature/wizard-polish` (it's a clean fast-forward), then continue with the TODO below on a **new** branch.
  - ❌ issue → fix on `feature/wizard-polish`, keep verify green, then merge.

### What this session built (all on `feature/wizard-polish`)
The previous session's product review (the old contents of this file) is now **implemented** — details live in `HANDOFF.md` "Current state" + data model, and `PITFALLS.md` #17–19. Summary:
- **Catalog-freshness suite** (the headline feature): `Catalog` sheet 7→10 cols (`+SourceUrl/PeriodBasis/Notes`, append-migrated by `ensureHeaders_`); `getCatalogData_` reads **by header name**; wizard shows `Last verified: <Mon YYYY>` + optional Source link + "Review recommended" stale flag; `reviewStaleCatalog()` monthly read-only email (never auto-edits — semi-automatic by design).
- **Quick wins**: NUL-byte fix in `dedupKey_`; two-pass edit-mode dedup + **client duplicate-name guard** (blocks save, asks to rename); `Clear all` confirm; `previewReminders()` read-only editor diagnostic.
- **Reminder cadence preset**: `CONFIG.REMINDER_CADENCE` `'minimal'` | `'persistent'` (+ `REMINDER_REPEAT_DAYS`).
- **Bug fix — raw date**: Sheets had coerced `Catalog.LastVerified` into a Date → showed "Mon Jun 01 2026 00:00:00 GMT-0700…" **and** silently broke stale detection. `verifiedKey_`/`verifiedLabel_` normalize string-or-Date on read (realm-safe `Object.prototype.toString`, not `instanceof`).
- **Wizard form polish**: `$` prefix + compact width on Annual fee / "Already used this year"; ⓘ CSS tooltip for the seed help; tightened anniversary Month/Day gap; fee↔anniversary gap closed (content-width, left-aligned).
- **4 new catalog cards** + auto-sync: added Capital One Venture X / Marriott Bonvoy Brilliant / Citi Strata Premier / Amex Green to the `CATALOG` constant; `appendMissingCatalog_` now appends newly-shipped cards into an existing `Catalog` sheet on `setup()` (append-only).

### Deploy + test (what the user is doing now)
Files changed this batch: **`Code.gs` + `AddCards.html`** (`Index`/`Confirm` unchanged).
1. Re-paste **both** `Code.gs` and `AddCards` into the Apps Script editor, Save.
2. **Run `setup()`** — migrates the existing `Catalog` sheet (appends the 3 columns + the 4 new cards, append-only) and (re)installs the `reviewStaleCatalog` monthly trigger.
3. *(optional)* **Run `previewReminders()`** — read-only; confirms the daily trigger + each benefit's next-reminder date (settles a "why no email this morning" question — a quiet mid-period day is expected).
4. **Manage deployments → Edit → New version** (keeps the same `/exec`; do NOT make a New deployment). Then **hard-refresh** the Add-cards page (Cmd+Shift+R / incognito — Apps Script HTML caches).

Verify in the live app (these can't be unit-tested): `Last verified: Jun 2026` line (not raw date) + `$` prefixes + ⓘ tooltip + fee/anniversary sit together; edit-mode duplicate-name is blocked with a rename prompt; the 4 new cards appear in the card dropdown.

### Carryover gotchas (this session)
- **`Catalog.LastVerified` Date-coercion** (PITFALLS #17): the user's existing sheet stores `LastVerified` as a coerced **Date**; it's normalized on read by `verifiedKey_`. Never `String(cell)` it directly; never restamp existing cells.
- **Read the Catalog by header NAME**, not column position (PITFALLS #18).
- **`appendMissingCatalog_` re-adds a deliberately-deleted catalog row** on the next `setup()` (acceptable for a personal tool — noted in code).
- The **4 new cards' amounts/fees are best-effort** (LastVerified 2026-06) — the user should verify against issuers; the stale flag will surface them later anyway.

### TODO for the next session (prioritized)
- **A. Merge `feature/wizard-polish` → main** once the user confirms the test passed.
- **B. Dashboard UI polish (review UI#2/#3):** mobile — `.ben` rows don't stack on narrow screens, add a small-screen media query in `Index.html`; and a friendly **empty state** + Add-Cards CTA when there are no benefits.
- **C. ⑧ Persist `PeriodBasis` into `Benefits`** — the real fix for review #4/#9 (a renamed benefit currently loses its `anniversary` basis because it's re-derived from `CATALOG` by name). Needs a `Benefits` column → append-only migration (PITFALLS #2/#3: widen `COL`/`HEADERS`/`seedExamples_` and every `newRows.push`), and read/write in `readRows_`/`addBenefits`/`updateCard`.
- **D. Conditional / spend-gated benefits** (HANDOFF backlog #2b): no transaction data → can't auto-unlock; `Notes`-based workaround for now; maybe an "unlocked?" toggle later.
- **E. Data correction:** CSR **The Edit** ($250 semiannual in code; from 2026 both $250s are usable anytime in the year).
- **F. Optional:** Cards-sheet annual-fee freshness columns (`AnnualFeeLastVerified`/`AnnualFeeSourceUrl`); a `?view=catalogReview` dashboard page (lower priority than the email).
- **G. Open-source prep** (user goal): `README.md` + license; for a **distribution copy** set `CONFIG.WEBAPP_URL = ''` (NOT in this personal repo); treat the catalog as community-maintained data; document "shipped catalog is best-effort, verify your own cards."
- **H. Remaining 3 cards** if the user wants them: Hilton Honors Aspire / Delta SkyMiles Reserve / Amex Business Platinum — credits are split/volatile, verify each amount before adding.

### Hard constraints (unchanged — see PITFALLS for why)
- Work on a **new branch**; keep `node verify.js` green and **extend it** for new pure logic; keep `STRINGS` en/zh **symmetric** (verify checks counts).
- Security model stays **execute as me / access "Only myself"**; `requireAuth_` on server fns; **no side-effecting GET**; **no new external/runtime network calls**.
- Sheet migrations **append columns + preserve values only** (PITFALLS #2) — never reorder/clear existing data.
- ⚠️ **Do NOT touch `CONFIG.WEBAPP_URL`** — it's pinned on purpose (PITFALLS #15). The review's "use `''`" applies **only** to an open-source/distribution copy, not this personal deployment. If you ever make a brand-new deployment, you must update it to the new `/exec`.
- Code goes live via **Manage deployments → Edit → New version** (not a New deployment).

### Commits this session (on `feature/wizard-polish`, newest first)
- `dc86541` docs: backlog note for conditional / spend-gated benefits
- `4450f85` Catalog: add 4 common cards + auto-sync new cards into existing sheet
- `abe5f23` docs: record catalog-freshness suite + cadence + new pitfalls
- `622402f` Wizard: close the fee/anniversary gap (content-width, left-aligned)
- `f71780a` Wizard polish: fix coerced-Date freshness, $ affordances, dup-name guard

(Already on `main` from earlier this session: `c56a59d` cadence, `990d2d3` review email, `f5f5bbc` AddCards freshness UI, `04e1469` catalog engine, `0cd3951` quick wins.)
