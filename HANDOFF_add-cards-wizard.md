# Handoff — "Add cards" benefit-catalog wizard

A self-contained task spec for a fresh Claude Code session. Read this top to bottom, then read
`BUILD_SPEC.md` (design decisions) and `Code.gs` (patterns to reuse) before writing anything.

## Context (what already exists)

A **credit-card recurring-benefit tracker** built on Google Apps Script + Sheets + Gmail. It is
deployed and working today:
- `Code.gs` — engine: daily `sendReminders()` email, `doGet` web app (dashboard + confirmation
  page), per-benefit Done / Snooze / Undo / Un-snooze, snooze with a duration picker capped at the
  benefit's expiry. i18n via a `STRINGS` table (`en`/`zh`).
- `Index.html` — dashboard. `Confirm.html` — email-link confirmation page.
- `SETUP.md` — deployment guide. `BUILD_SPEC.md` — authoritative design doc.
- Data lives in a `Benefits` sheet. Columns (exact order): `ID, Card, Benefit, Amount, Category,
  Reset, ReminderDays, LastDonePeriod, LastReminded, SnoozeUntil`. First 7 are user data; last 3
  are managed automatically (leave blank).
- `Reset` supports `monthly / quarterly / semiannual / annual / once` (calendar-based), parsed
  forgivingly by `normalizeReset_()`.
- Security model is strict (see "Constraints" below). The owner currently tracks **CSP (Chase
  Sapphire Preferred)** and **Amex Gold**; they want to share the app with friends, where **each
  friend runs their own private copy**.

Today, adding benefits means hand-editing the `Benefits` sheet. **This task replaces that with a
friendly in-app wizard.**

## Goal / desired UX

A page where the user:
1. **Picks a card** (dropdown of known cards + "card not listed → type it").
2. Sees that card's **known recurring benefits** pre-filled (name, amount, category, reset,
   reminder cadence), each with a **checkbox** and **editable fields**.
3. **Confirms** the ones they have (tick / untick, tweak amounts).
4. **Adds anything missing** via a guided "add a benefit" form (field hints + dropdowns).
5. Clicks **"Add to my tracker"** → selected rows are written into the `Benefits` sheet.
6. Can repeat for the next card. Then go to the dashboard.

## Architecture decision (do not skip)

**The runtime app has no AI and must not depend on live web calls.** So "show the card's latest
benefits" is served from a **catalog dataset shipped in the code**, researched at build time. The
freshness model is: the catalog carries a `lastVerified` date + a visible "verify with your
issuer" disclaimer, and the manual-add form is the escape hatch for anything missing or changed.

- The catalog is a `CATALOG` constant in code (so it ships to friends' copies too).
- `setup()` (or a new `setupCatalog()`) writes it into a **`Catalog` sheet** on first run, so it's
  inspectable/editable in the user's own account (consistent with "Sheet = the database"). The
  wizard reads the `Catalog` sheet if present, else falls back to the `CATALOG` constant.
- **Researching the catalog IS the B+C step**: the next session web-searches each seed card's
  current (2026) benefits and encodes them. **Seed exactly these four cards (owner-confirmed):**
  Chase Sapphire Preferred, Amex Gold, Amex Platinum, Chase Sapphire Reserve. More can be added
  later by appending to the `Catalog` sheet.

## Data model — the catalog

`CATALOG` shape (illustrative — **the next session must verify/replace amounts & cadence via web
search**; these values are placeholders):

```javascript
const CATALOG = {
  'Amex Gold': {
    lastVerified: '2026-06',
    benefits: [
      { benefit: 'Uber Cash',     amount: '$10', category: 'other',  reset: 'monthly',    reminderDays: 4 },
      { benefit: 'Dining credit', amount: '$10', category: 'dining', reset: 'monthly',    reminderDays: 4 },
      { benefit: 'Resy credit',   amount: '$50', category: 'dining', reset: 'semiannual', reminderDays: 21 },
      { benefit: 'Dunkin credit', amount: '$7',  category: 'dining', reset: 'monthly',    reminderDays: 7 },
    ],
  },
  'Chase Sapphire Preferred': {
    lastVerified: '2026-06',
    benefits: [
      { benefit: 'Hotel credit (Chase Travel)', amount: '$50', category: 'hotel', reset: 'annual', reminderDays: 30 },
      // ... research & complete ...
    ],
  },
  // ... more cards ...
};
```

Each catalog benefit maps 1:1 to the `Benefits` schema (minus ID, which is generated). `category`
must be one of: travel / dining / hotel / streaming / grocery / lounge / other. `reset` must be a
value `normalizeReset_()` accepts.

## UI — new file `AddCards.html`

- Reached via `doGet(?view=add)` and a **"+ Add cards"** link on the dashboard (`Index.html`).
- Card selector: `<select>` populated from the catalog + an "Other (type a name)" option that
  reveals a text input.
- On card select: render its benefits as rows, each = checkbox + benefit name + editable Amount +
  Category `<select>` + Reset `<select>` + ReminderDays number. Pre-fill from catalog. Default
  checked = your call; recommend **unchecked** so the user opts in deliberately (ask the user).
- "Add another benefit" → a blank row with the same fields + placeholder hints.
- "Add to my tracker" button → `google.script.run.addBenefits(card, items)`; on success show a
  summary ("Added 4, skipped 1 already tracked") + links: add another card / open dashboard.
- Match the existing visual design (flat, warm-white `#faf9f5`, surface cards, 12px radius,
  weight-500 headings, soft pill styles) and be mobile-friendly. All visible strings come from a
  passed-in `UI` object (extend `STRINGS` + `uiStrings_`), no hardcoded English.

## Server functions (add to `Code.gs`)

- `getCatalog()` → returns `{ cards: [{ card, lastVerified, benefits:[...] }] }` from the `Catalog`
  sheet (or `CATALOG` constant). Behind `requireAuth_()`.
- `addBenefits(card, items)` → `requireAuth_()`, `LockService` lock, then for each item: validate
  category + `normalizeReset_(reset)`, generate a unique `ID` (slug of card+benefit, suffix `-2`
  on collision), **dedupe** against existing `Benefits` rows (same card + benefit name,
  case-insensitive — skip and report), append accepted rows in one batched write. Return
  `{ added, skipped }`. Reuse existing patterns (`readRows_`, column constants, text-format the
  `LastDonePeriod` cell as in `applyAction_`).
- `setupCatalog()` (or extend `setup()`): create/seed the `Catalog` sheet from `CATALOG` if absent.

## Integration points

- `doGet`: add a `view === 'add'` branch (still inside the `isAuthorized_()` gate) that renders
  `AddCards.html` with `jsonForHtml_(getCatalog())` + `jsonForHtml_(uiStrings_())`.
- Dashboard: add a "+ Add cards" link near the header that navigates to `?view=add`.
- Reuse `t_`/`fmt_`, `jsonForHtml_`, `requireAuth_`, `LockService`, `HtmlService
  .createTemplateFromFile`, `setXFrameOptionsMode(DEFAULT)`.

## Build checklist (ordered)

1. **Research & encode `CATALOG`** for the agreed seed cards (CSP + Amex Gold first). Web-search
   current 2026 benefits; set each card's `lastVerified`.
2. `getCatalog()` + `addBenefits()` + `setupCatalog()` server functions (auth + lock + dedup).
3. `AddCards.html` wizard UI (matches design, i18n, mobile).
4. Dashboard "+ Add cards" entry + `doGet` route for `?view=add`.
5. Extend `STRINGS` (en + zh) and `uiStrings_` with the new labels.
6. Update `SETUP.md` (new "Start by adding your cards" step) and `BUILD_SPEC.md`.
7. **Test**: open `?view=add` → select Amex Gold → see benefits → tick some + add a custom one →
   Add → confirm rows appear in `Benefits` and on the dashboard; re-adding the same card skips
   duplicates; a card typed manually with a custom benefit works.

## Constraints to preserve (do NOT violate)

- **Security:** deploy stays **execute as me / access "Only myself"**; never default to "Anyone".
  Every new server function calls `requireAuth_()`. No new external/runtime network calls.
- **No silent GET mutations:** all writes go through `google.script.run` + `LockService`, never a
  side-effecting GET.
- **i18n:** every user-facing string via `STRINGS`/`t_`; seed `en` and `zh`.
- **Reset cadences:** monthly / quarterly / semiannual / annual / once, calendar-based.
- **Sheet = the database; keep it inspectable.** Don't add a separate backend or service.
- **`LastDonePeriod` must be plain-text** (`setNumberFormat('@')`) — preserve this; don't
  reintroduce date coercion.
- After any code change, **re-deploy a new version** (Manage deployments → Edit → New version).
- Files in play: `Code.gs`, `Index.html`, `Confirm.html`, `AddCards.html` (new), `SETUP.md`,
  `BUILD_SPEC.md`.

## Decisions (resolved by owner — do not re-ask)

1. **Seed cards:** Chase Sapphire Preferred, Amex Gold, Amex Platinum, Chase Sapphire Reserve.
2. **Catalog benefits start UNCHECKED** (opt-in): the user ticks the ones they actually want to
   track, so nothing niche is added by accident. (Trivial to flip to pre-checked later.)
3. **Catalog lives in code AND an editable `Catalog` sheet**, seeded from the `CATALOG` constant
   on first run; the wizard reads the sheet so benefits can be updated over time.
4. **Benefit names stay English**; localize only the UI chrome (labels/buttons) via `STRINGS`.
