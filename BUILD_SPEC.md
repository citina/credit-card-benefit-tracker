# Credit Card Benefit Tracker — build spec

A handoff for Claude Code. Read this top to bottom before writing code. Reference
implementations of the two files are included at the end as a starting point — improve on
them, don't treat them as final.

## What we're building and why

The real problem is **forgetting to use recurring card benefits before they expire** (e.g.
"$10 Uber Cash each month", "$300 annual travel credit"). It is NOT reward optimization or
deciding which card to swipe. So the design priority is: a reminder that arrives on its own,
a one-tap way to mark a benefit used, and a status page I can check anytime.

A chat-only / browser-only app can't do this — it can't run on a schedule or message the
user. So the engine must live somewhere with a scheduler and outbound messaging.

## Stack (decided)

**Google Apps Script + Google Sheets + Gmail.** Reasons: free, no bank-account linking, data
lives in the user's own Google account and is fully inspectable, Apps Script has time-based
triggers that run when nothing is open, and `MailApp` sends email natively. Do not introduce
a separate backend, database, or third-party service.

- Sheet = the database.
- Daily time-based trigger = checks what's unused/due and emails a checklist.
- Web app (`doGet`) = serves a dashboard AND handles the Done/Snooze confirmations.

## Security model (top priority — get this right first)

Hard requirement: **only the owner, or people the owner explicitly authorizes, can see or
change anything.** Access is gated by Google identity, not by a secret in a URL.

- **Default deployment: execute as _Me_, access _Only myself_.** Google blocks everyone except
  the owner's signed-in account, so the dashboard and every email link are private. This fully
  satisfies the requirement on a personal Gmail account. Reminder links still work because you
  open them on your phone, where you're already signed in to that Google account.
- **Token is no longer the access guard — it's defense-in-depth.** Since identity is enforced by
  Google, the dashboard does not depend on a URL secret. Keep the `TOKEN` check on
  state-changing actions as a cheap extra guard (and to make stray requests harmless), but do
  not present it as the security boundary. Under _Only myself_ the token is optional.
- **No silent GET mutations.** Done/Snooze links open a **confirmation page** that performs no
  write; the change happens only when the user taps a button there (via `google.script.run`).
  This stops email link-scanners, previewers, and prefetchers from marking benefits
  done/snoozed without an explicit click.
- **Authorizing other people — `AUTHORIZED_EMAILS` allowlist (seam, off by default).** `doGet`
  compares `Session.getActiveUser().getEmail()` against `CONFIG.AUTHORIZED_EMAILS` (empty =
  owner-only). **Important: under the default _Only myself_ deployment this check is inert** —
  Google already lets only the owner reach `doGet`, so the allowlist never sees anyone else.
  Authorizing others therefore requires *both* raising the deployment access level (to "Anyone
  with a Google account") *and* populating the allowlist. Even then there's a hard caveat: the
  allowlist is **enforceable only on Google Workspace (custom domain)** — on a personal
  `@gmail.com`, when the app executes as the owner the accessing user's email is usually not
  exposed, so it can't be filtered. So on personal Gmail the real choices are: keep _Only
  myself_ (default, most secure); move to Workspace to use the allowlist; or — only if sharing
  is genuinely needed — switch access to _Anyone_ and rely on the secret-link `TOKEN`
  (explicitly weaker, opt-in).
- Set `XFrameOptionsMode` to `DEFAULT` (same-origin), not `ALLOWALL`.

## Decisions already made (don't relitigate)

1. **Tap-links, not reply parsing.** Each reminder email line has a **Done** link and a
   **Snooze** link that open a confirmation page in the web app; the sheet changes only after an
   explicit tap on that page (see Security model). Free-text email-reply parsing ("just reply
   DONE") was rejected as unreliable (quoted text, threading, ambiguity about which benefit a
   reply refers to). If the user later insists on literal text replies, it can be added as a
   Gmail-scanning trigger — leave a clear extension point but don't build it now.
2. **Email channel, not SMS.** SMS would need Twilio (cost + setup). Keep a note that SMS is a
   possible later add-on; default is Gmail.
3. **Status is derived, not a stored flag.** A benefit is "done" if its `LastDonePeriod`
   equals the current period key for its reset frequency. This auto-resets monthly/annual
   benefits at period boundaries without a separate reset job. Don't store a mutable
   done/pending boolean.

## Reminder behavior (the core logic)

Daily trigger runs `sendReminders()`. Reminders are **period-driven**: each unused benefit is
nudged **once at the start of its period** ("you have a fresh credit") and **once more as the
period nears its end** ("use it before it resets"). There is no per-benefit "remind every N days"
cadence — the rhythm follows the reset frequency itself.

For each benefit, include it in today's email only if ALL of these hold:
- it is NOT done for the current period, AND
- it is NOT currently snoozed (`now < SnoozeUntil`), AND
- today hits one of its two trigger points and that point hasn't been reminded yet this period:
  - **start-of-period** — `LastReminded` falls before the current period's first day, OR
  - **near-expiry** — today is within the lead window before period end
    (`periodEnd − leadDays + 1`) and `LastReminded` falls before that window. Lead days scale with
    period length: monthly 5, quarterly 10, semiannual/annual 30. `once` has no expiry, so it gets
    only the single start nudge.

`LastReminded` (a date) is the only stored state; comparing its day number against each trigger day
guarantees each nudge fires at most once per period. If at least one benefit qualifies, send a
single checklist email listing all of them, each with Done + Snooze links, plus a link to the
dashboard. Stamp `LastReminded = today` on every benefit included. If nothing qualifies, send
nothing.

- **Done link** opens a confirmation page ("Mark _Uber Cash_ as done?"). On confirm it sets
  `LastDonePeriod` to the current period key and clears any snooze.
- **Snooze link** opens a confirmation page; on confirm it sets `SnoozeUntil = today + N days`
  (default N = `CONFIG.SNOOZE_DEFAULT_DAYS`; the link may override via a `days` param).
- The confirmation page writes nothing on load; the change is committed by a `google.script.run`
  call when the user taps the button. This is one extra tap versus the original one-tap goal —
  the deliberate cost of making email link prefetch/scanning safe; the dashboard stays
  single-action.
- State-changing calls still carry the `token` and reject mismatches, but as defense-in-depth:
  under the default _Only myself_ deployment Google sign-in is the real guard, not the token.

## Period keys

- `monthly` → `yyyy-MM`
- `quarterly` → `yyyy-Qn` (calendar quarter, e.g. `2026-Q2`)
- `semiannual` → `yyyy-Hn` (`H1` = Jan–Jun, `H2` = Jul–Dec)
- `annual` → `yyyy`
- `once` (or any value that isn't one of the above) → constant `"ONCE"`

Use `Session.getScriptTimeZone()` and `Utilities.formatDate` so this respects the user's
timezone, not UTC. Set the Apps Script **project time zone** (Project Settings) to the user's
zone — both these period keys and the daily trigger's `atHour` follow it.

## Reliability & correctness

- **Day math in the script timezone.** Day-number comparisons (period start/end vs `LastReminded`,
  snooze clamping) use calendar days in `Session.getScriptTimeZone()` via `dayNumber_`, not raw
  `getTime()` UTC milliseconds, or the reminder trigger days drift by a day around DST/midnight.
- **Locks.** Guard every sheet mutation (link actions + `sendReminders`) with `LockService`.
- **Batched writes.** Stamp `LastReminded` for all reminded rows in one range write, not
  row-by-row inside the loop.
- **Graceful when unconfigured.** If `setup()` hasn't created the sheet, the dashboard and the
  confirmation actions show a "Run setup() first" message instead of throwing.
- **Store period keys as text.** Write `LastDonePeriod` to a plain-text cell
  (`setNumberFormat('@')` before `setValue`) — otherwise Sheets coerces a monthly key like
  `2026-06` into a Date, and it never matches `periodKey_()` on read (the benefit looks un-done
  after reload). Annual `2026` survives by luck; monthly is the one that breaks.

## Data model — sheet `Benefits`

Columns in this exact order (header row, frozen, bold):

| # | Column | Notes |
|---|--------|-------|
| 1 | ID | stable unique string, e.g. `amex_uber` |
| 2 | Card | display name, e.g. `Amex Gold` |
| 3 | Benefit | e.g. `Uber Cash` |
| 4 | Amount | free text, e.g. `$10`, `12 visits`, `Unlimited` |
| 5 | Category | travel / dining / hotel / streaming / grocery / lounge / other |
| 6 | Reset | `monthly` / `quarterly` / `semiannual` / `annual` / `once` (anything else → one-time). Calendar-based: quarters Jan–Mar…, halves Jan–Jun / Jul–Dec |
| 7 | ReminderDays | legacy/unused — reminders are now period-driven; kept for schema stability |
| 8 | LastDonePeriod | period key when last marked done; blank = never |
| 9 | LastReminded | date of last reminder |
| 10 | SnoozeUntil | date; blank = not snoozed |

`setup()` should create the sheet + header if missing, seed a few example rows, and register
the daily trigger (deleting any prior `sendReminders` trigger first so re-running is safe).

## Dashboard (web app, `doGet` with no action)

Serve an HTML page that reads live from the sheet and shows, grouped by card:
- a summary row (benefits tracked / still to use / done) — a snoozed benefit still counts as
  "still to use" (snoozing defers the reminder, not the obligation); only marking done reduces it,
- each benefit with a status badge (Done / To use / Snoozed) and inline actions: **Mark done**,
  **Snooze** (by `CONFIG.SNOOZE_DEFAULT_DAYS`), and **Undo**. Pending rows show Mark done +
  Snooze; snoozed rows can be un-snoozed; done rows show **Undo** (clears the current period's
  done state) so a mis-tap is recoverable without opening the sheet. Snooze is **two-step**: the
  Snooze button reveals a menu (**Pick a date** / **Skip this period** / **Cancel**); choosing **Pick
  a date** shows a date picker with **Confirm** / **Cancel** (the two Cancels step back one level),
  while **Skip this period** snoozes through period end (no more reminders this cycle). The picked date is **clamped so
  it never lands past the benefit's expiry** (period end), enforced server-side via the pure helper
  `snoozeUntilDayNumber_` (so even an email Snooze link can't overshoot); a snoozed row shows when it
  returns (e.g. "Snoozed until Jun 18"). (The email/confirm Snooze link still uses a fixed N days.)
- a **sort control** above the cards reorders benefits **within each card** (grouping preserved):
  Expiry (default) / Amount / Name / sheet order, with **done benefits pinned to the bottom** of each
  card (group by status, then sort). Done rows show a muted **"resets &lt;date&gt;"** (when the credit
  refreshes) where pending rows show days-left + expiry.

Each action calls a server function via `google.script.run` (`markDone` / `snooze` / `undo`)
and re-renders with the returned data (no full page reload). If `setup()` hasn't created the
sheet yet, render a clear "Run setup() first" message instead of throwing.

### Visual design (match this — the user liked it)

Clean, flat, light. No gradients, no shadows. Warm-white background `#faf9f5`, white surface
cards with 1px `#e6e4dc` borders and 12px radius. Headings weight 500 (never 700), sentence
case. Status badges as soft pills: done = green (`#EAF3DE`/`#27500A`), pending = amber
(`#FAEEDA`/`#633806`), snoozed = gray (`#F1EFE8`/`#444441`). Done benefits show
strikethrough + muted text. System font stack. Mobile-friendly (single column, viewport meta
tag) since the user opens links from their phone.

## Strings & i18n (build now, don't defer)

All user-facing text lives in one `STRINGS` table keyed by language, e.g.
`STRINGS[CONFIG.LANG].badgeDone` — email subject + body, dashboard labels, status badges, and
confirmation-page messages. No hardcoded English scattered through the code (the reference
implementation does this wrong; fix it). `CONFIG.LANG` selects `'en'` or `'zh'`; the user reads
both, so seed both. A third language is then just one more block.

## CONFIG block (top of Code.gs)

- `EMAIL` — defaults to `Session.getEffectiveUser().getEmail()` (the owner).
- `LANG` — `'en'` or `'zh'`; selects the `STRINGS` set.
- `AUTHORIZED_EMAILS` — array; empty = owner-only (see Security model for the Workspace caveat).
- `TOKEN` — long random string. Required only in _Anyone_ sharing mode, where it is the guard;
  under the default _Only myself_ it is redundant defense-in-depth and can be left at default.
- `DEFAULT_REMINDER_DAYS` — 4. Legacy: only fills the `ReminderDays` column on new rows; the
  period-driven reminder logic no longer reads it.
- `SNOOZE_DEFAULT_DAYS` — 3.
- `DAILY_HOUR` — 9 (24h local).
- `SHEET_NAME` — `Benefits`.

## Deployment steps to document in a SETUP.md

1. Create a new Google Sheet → Extensions → Apps Script.
2. Paste `Code.gs`; add HTML files named exactly `Index` and `Confirm`, and paste `Index.html`
   and `Confirm.html`.
3. Set `CONFIG.LANG`; optionally set a long random `CONFIG.TOKEN`. Leave `AUTHORIZED_EMAILS`
   empty for owner-only.
4. Run `setup()` once; approve the permission prompts (Sheets, Gmail, triggers).
5. Deploy → New deployment → type **Web app** → execute as **me** → who has access **Only
   myself**. Copy the web app URL — this is the dashboard, and reminder links use it. (You must
   be signed in to this Google account on the device where you open the links — on your own
   phone you already are.)
6. (Re-deploy as a new version after any code change, or links/dashboard stay on old code.)
7. Edit the sheet rows to your real cards/benefits.

**To authorize other people (optional):** the secure path is Google Workspace — add their
emails to `AUTHORIZED_EMAILS` and set access to "Anyone with a Google account". On a personal
`@gmail.com` the allowlist can't be enforced (see Security model); if you must share there, set
access to "Anyone" and treat the `TOKEN` link as the guard — explicitly weaker.

Mention iPhone use: links open in Safari fine; the dashboard can be added to the Home Screen.

## Notes / extension points to leave clean

- Bilingual (Chinese/English) is **built now**, not deferred — see "Strings & i18n"; `LANG`
  switches the whole UI and the email.
- Multi-user/authorized access: the `AUTHORIZED_EMAILS` allowlist is the seam, fully usable on
  Google Workspace. Don't build beyond the allowlist check now.
- SMS via Twilio and literal email-reply parsing are deferred — leave obvious seams, don't build.
- Optional later: a "which card / what rewards for this purchase" helper. Out of scope here;
  it's an occasional question better asked in chat than baked into a daily reminder tool.
- An interactive **"Add cards" catalog wizard** (pick a card → confirm its known benefits → add
  missing ones, instead of hand-editing the sheet) — **built**, see below.

## Add-cards wizard (built)

Replaces hand-editing the `Benefits` sheet with an in-app flow. (Original build spec
`HANDOFF_add-cards-wizard.md` was retired once built — see git history.)

- **Catalog data ships in code** as the `CATALOG` constant (so every friend's copy gets it),
  researched/verified 2026-06: Chase Sapphire Preferred, Amex Gold, Amex Platinum, Chase Sapphire
  Reserve. Only genuinely recurring "use-it-or-lose-it" credits are listed (not multipliers,
  sign-up bonuses, or every-few-years perks). Each entry carries a `lastVerified` date; the wizard
  shows it with a "verify with your issuer" note, and manual-add is the escape hatch for anything
  missing or changed.
- `setup()` seeds an **editable `Catalog` sheet** from `CATALOG` (columns `Card, LastVerified,
  Benefit, Amount, Category, Reset, ReminderDays`). The wizard reads that sheet if present (user
  edits win), else falls back to the constant — consistent with "the Sheet is the database".
- **UI** (`AddCards.html`, reached via the dashboard's **+ Add cards** link or `?view=add`): pick a
  card → its benefits render as editable rows, **unchecked by default** (deliberate opt-in) → tick
  the ones you have, edit amounts, add missing ones → **Add to my tracker**. A **Select all / Clear
  all** bar above the rows flips every visible (non-removed, enabled) checkbox at once. "Other (type
  a name)" handles cards not in the catalog. Same flat warm-white design; fully localized (en/zh)
  from a passed-in `UI` object; mobile-friendly.
- **Server** (`Code.gs`, all behind `requireAuth_()`): `getCatalog()` reads the catalog;
  `addBenefits(card, items)` takes a `LockService` lock, validates each item (category coerced into
  the allowed set, `reset` via `normalizeReset_`), generates a unique slug `ID` (`-2` suffix on
  collision), **dedupes** against existing rows (same card + benefit, case-insensitive — skipped &
  counted), and appends accepted rows in one batched write with `LastDonePeriod` kept plain-text.
  Returns `{ added, skipped }`. No new external/runtime network calls; no side-effecting GET.
- **Edit / remove from the dashboard:** every card has a **⋮ menu**. **Edit card** reopens the wizard
  in edit mode (`?view=add&edit=<card>`): the card's current rows are prefilled and checked, its
  not-yet-added catalog benefits are listed unchecked, and **Save** calls `updateCard(card, items)` —
  items carrying an id whose values actually changed are updated in place (status columns
  `LastDonePeriod`/`LastReminded`/`SnoozeUntil` preserved; unchanged rows kept but not reported),
  this card's rows that weren't resubmitted are deleted, new ones appended (auth + lock; delete
  bottom-up after writes). **Remove card** (same menu, inline confirm) deletes the whole card via
  `removeCard`. Per-benefit removal goes through edit mode — there's no separate per-row control on
  the dashboard.
- **Edit-mode row removal (no `×`):** edit rows have **no `×`** — a benefit is removed from the card
  by **unchecking** it (it then isn't resubmitted, so `updateCard` deletes it). A **user-added**
  (non-catalog) benefit — flagged `custom` by `getCardRows_` — additionally shows a red **Delete**
  button once unchecked (catalog benefits don't, since they can be re-added later from suggestions).
  In **add** mode, manually-added rows still hard-delete on `×`.
- **Success banner:** on a successful add a slim top banner shows **"{card} is added to your
  dashboard."** and resets to the card picker (add another immediately); edit-mode save shows the
  Updated/Added/Removed summary + **Keep editing**. (The header link returns to the dashboard.)

---

## Required changes to the reference implementation

The two code blocks below are the **original baseline and predate the decisions above.** They
have since been implemented as `Code.gs`, `Index.html`, and `Confirm.html` in this folder (those
files are authoritative); the blocks below and this checklist are kept only for design context.

1. **Deployment/access:** deploy _execute as me / access Only myself_ (not "Anyone"). Add an
   `AUTHORIZED_EMAILS` check at the top of `doGet` (empty list = owner-only; deny otherwise).
2. **Confirmation page:** for `action=done|snooze`, `doGet` renders a confirmation page that
   writes nothing. Keep the write logic in the `google.script.run`-callable functions
   (`markDone`/`snooze`/`undo`) — both the dashboard and the confirmation-page button call them;
   the email-link GET must no longer mutate on its own. (Don't gut `handleAction_`'s write
   logic — just stop invoking it directly from the GET path.)
3. **Centralized strings:** add a `STRINGS` table + `CONFIG.LANG`; replace every hardcoded
   English string in the email, dashboard, and messages with a lookup. Seed `en` and `zh`.
4. **Dashboard actions:** add server functions `snooze` and `undo` next to `markDone`, plus the
   matching buttons in `Index.html`. `undo` clears `LastDonePeriod` for the current period.
5. **Timezone-safe day math:** rewrite `daysBetween_` to diff `yyyy-MM-dd` strings in the script
   timezone instead of raw UTC milliseconds.
6. **Locks + batched writes:** wrap mutations in `LockService`; in `sendReminders`, write all
   `LastReminded` stamps in one batched range update instead of per-row `setValue` in the loop.
7. **Config:** add `LANG`, `AUTHORIZED_EMAILS`, `SNOOZE_DEFAULT_DAYS`; default `EMAIL` to
   `Session.getEffectiveUser().getEmail()`; `TOKEN` becomes defense-in-depth only.
8. **Graceful unconfigured state:** if the sheet is missing, show "Run setup() first" instead of
   throwing, in both `doGet` and the actions.
9. **Headers:** set `XFrameOptionsMode` to `DEFAULT` (same-origin), not `ALLOWALL`.

## Reference implementation — `Code.gs` (baseline — see checklist above)

```javascript
// ----------------------------- CONFIG -----------------------------
const CONFIG = {
  EMAIL: Session.getActiveUser().getEmail(),
  TOKEN: 'CHANGE_ME_to_a_long_random_string_8f3kd92',
  DEFAULT_REMINDER_DAYS: 4,
  DAILY_HOUR: 9,
  SHEET_NAME: 'Benefits',
};

const COL = {
  ID: 1, CARD: 2, BENEFIT: 3, AMOUNT: 4, CATEGORY: 5,
  RESET: 6, REMINDER_DAYS: 7, LAST_DONE_PERIOD: 8,
  LAST_REMINDED: 9, SNOOZE_UNTIL: 10,
};
const HEADERS = ['ID', 'Card', 'Benefit', 'Amount', 'Category', 'Reset',
                 'ReminderDays', 'LastDonePeriod', 'LastReminded', 'SnoozeUntil'];

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    seedExamples_(sheet);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders')
    .timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
  Logger.log('Setup complete. Now deploy as a Web App.');
}

function seedExamples_(sheet) {
  const rows = [
    ['amex_dining', 'Amex Gold', 'Dining credit', '$10', 'dining', 'monthly', 4, '', '', ''],
    ['amex_uber',   'Amex Gold', 'Uber Cash',     '$10', 'other',  'monthly', 4, '', '', ''],
    ['csr_travel',  'Chase Sapphire Reserve', 'Annual travel credit', '$300', 'travel', 'annual', 14, '', '', ''],
    ['csr_lounge',  'Chase Sapphire Reserve', 'Priority Pass lounge', 'Unlimited', 'lounge', 'annual', 30, '', '', ''],
  ];
  rows.forEach(function (r) { sheet.appendRow(r); });
}

function periodKey_(reset, date) {
  const tz = Session.getScriptTimeZone();
  if (reset === 'monthly') return Utilities.formatDate(date, tz, 'yyyy-MM');
  if (reset === 'annual')  return Utilities.formatDate(date, tz, 'yyyy');
  return 'ONCE';
}
function daysBetween_(a, b) { return Math.floor((b.getTime() - a.getTime()) / 86400000); }

function readRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const last = sheet.getLastRow();
  if (last < 2) return { sheet: sheet, rows: [] };
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const rows = values.map(function (v, i) {
    return {
      rowIndex: i + 2,
      id: String(v[COL.ID - 1]),
      card: v[COL.CARD - 1],
      benefit: v[COL.BENEFIT - 1],
      amount: v[COL.AMOUNT - 1],
      category: v[COL.CATEGORY - 1],
      reset: String(v[COL.RESET - 1] || 'monthly'),
      reminderDays: Number(v[COL.REMINDER_DAYS - 1]) || CONFIG.DEFAULT_REMINDER_DAYS,
      lastDonePeriod: String(v[COL.LAST_DONE_PERIOD - 1] || ''),
      lastReminded: v[COL.LAST_REMINDED - 1] ? new Date(v[COL.LAST_REMINDED - 1]) : null,
      snoozeUntil: v[COL.SNOOZE_UNTIL - 1] ? new Date(v[COL.SNOOZE_UNTIL - 1]) : null,
    };
  });
  return { sheet: sheet, rows: rows };
}

function isDone_(row, now) { return row.lastDonePeriod === periodKey_(row.reset, now); }

function sendReminders() {
  const now = new Date();
  const data = readRows_();
  const due = [];
  data.rows.forEach(function (row) {
    if (isDone_(row, now)) return;
    if (row.snoozeUntil && now < row.snoozeUntil) return;
    if (row.lastReminded && daysBetween_(row.lastReminded, now) < row.reminderDays) return;
    due.push(row);
  });
  if (due.length === 0) return;

  const webAppUrl = ScriptApp.getService().getUrl();
  const subject = 'Card benefits to use (' +
    Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d') + ')';

  let html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px">';
  html += '<h2 style="font-weight:500;color:#111">You have ' + due.length +
          ' benefit' + (due.length > 1 ? 's' : '') + ' to use</h2>';
  html += '<table style="width:100%;border-collapse:collapse">';
  due.forEach(function (row) {
    const doneUrl = webAppUrl + '?action=done&id=' + encodeURIComponent(row.id) +
                    '&token=' + encodeURIComponent(CONFIG.TOKEN);
    const snoozeUrl = webAppUrl + '?action=snooze&days=3&id=' + encodeURIComponent(row.id) +
                      '&token=' + encodeURIComponent(CONFIG.TOKEN);
    html += '<tr style="border-bottom:1px solid #eee">' +
      '<td style="padding:12px 8px 12px 0;vertical-align:top">' +
        '<div style="font-size:15px;color:#111">' + row.benefit + ' — ' + row.amount + '</div>' +
        '<div style="font-size:13px;color:#777">' + row.card + ' · resets ' + row.reset + '</div>' +
      '</td>' +
      '<td style="padding:12px 0;text-align:right;white-space:nowrap;vertical-align:top">' +
        '<a href="' + doneUrl + '" style="display:inline-block;padding:7px 14px;background:#0F6E56;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Done</a>&nbsp;' +
        '<a href="' + snoozeUrl + '" style="display:inline-block;padding:7px 14px;background:#f1efe8;color:#444;border-radius:6px;text-decoration:none;font-size:13px">Snooze 3d</a>' +
      '</td></tr>';
    data.sheet.getRange(row.rowIndex, COL.LAST_REMINDED).setValue(now);
  });
  html += '</table>';
  html += '<p style="margin-top:20px"><a href="' + webAppUrl +
          '" style="color:#185FA5">Open the full dashboard →</a></p></div>';
  MailApp.sendEmail({ to: CONFIG.EMAIL, subject: subject, htmlBody: html });
}

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'done' || action === 'snooze') {
    if (e.parameter.token !== CONFIG.TOKEN) return htmlMessage_('Invalid link.');
    return handleAction_(action, e.parameter);
  }
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.dataJson = JSON.stringify(buildDashboardData_());
  return tpl.evaluate()
    .setTitle('Card Benefit Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function handleAction_(action, params) {
  const now = new Date();
  const data = readRows_();
  const row = data.rows.filter(function (r) { return r.id === String(params.id); })[0];
  if (!row) return htmlMessage_('Benefit not found.');
  if (action === 'done') {
    data.sheet.getRange(row.rowIndex, COL.LAST_DONE_PERIOD).setValue(periodKey_(row.reset, now));
    data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL).setValue('');
    return htmlMessage_('✓ Marked "' + row.benefit + '" as done.');
  }
  const days = Number(params.days) || 3;
  const until = new Date(now.getTime() + days * 86400000);
  data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL).setValue(until);
  return htmlMessage_('Snoozed "' + row.benefit + '" for ' + days + ' days.');
}

function markDoneFromUi(id) {
  handleAction_('done', { id: id, token: CONFIG.TOKEN });
  return buildDashboardData_();
}

function buildDashboardData_() {
  const now = new Date();
  const data = readRows_();
  const cards = {};
  data.rows.forEach(function (row) {
    if (!cards[row.card]) cards[row.card] = { card: row.card, benefits: [] };
    cards[row.card].benefits.push({
      id: row.id, benefit: row.benefit, amount: row.amount, category: row.category,
      reset: row.reset, done: isDone_(row, now),
      snoozed: !!(row.snoozeUntil && now < row.snoozeUntil),
    });
  });
  return { cards: Object.keys(cards).map(function (k) { return cards[k]; }) };
}

function htmlMessage_(msg) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Arial;padding:40px;text-align:center;font-size:18px;color:#111">' +
    msg + '<br><br><a href="' + ScriptApp.getService().getUrl() +
    '" style="color:#185FA5;font-size:15px">Open dashboard</a></div>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
```

## Reference implementation — `Index.html` (baseline — see checklist above)

```html
<!DOCTYPE html>
<html>
<head>
<base target="_top">
<style>
  :root {
    --bg:#faf9f5; --surface:#fff; --text:#1a1a18; --muted:#6b6a64; --border:#e6e4dc;
    --green-bg:#EAF3DE; --green-tx:#27500A; --amber-bg:#FAEEDA; --amber-tx:#633806;
    --gray-bg:#F1EFE8; --gray-tx:#444441;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
       background:var(--bg);color:var(--text);padding:24px 16px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:22px;font-weight:500;margin-bottom:4px}
  .sub{font-size:14px;color:var(--muted);margin-bottom:24px}
  .summary{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;flex:1;min-width:120px}
  .stat .n{font-size:24px;font-weight:500}
  .stat .l{font-size:13px;color:var(--muted);margin-top:2px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:16px}
  .card-name{font-size:16px;font-weight:500;margin-bottom:12px}
  .ben{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-top:1px solid var(--border)}
  .ben:first-of-type{border-top:none}
  .ben-info .name{font-size:15px}
  .ben-info .name.done{text-decoration:line-through;color:var(--muted)}
  .ben-info .meta{font-size:13px;color:var(--muted);margin-top:2px}
  .ben-right{display:flex;align-items:center;gap:10px;white-space:nowrap}
  .badge{padding:4px 10px;border-radius:99px;font-size:12px;font-weight:500}
  .b-done{background:var(--green-bg);color:var(--green-tx)}
  .b-pending{background:var(--amber-bg);color:var(--amber-tx)}
  .b-snooze{background:var(--gray-bg);color:var(--gray-tx)}
  button.mark{font-size:13px;padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text)}
  button.mark:hover{background:var(--bg)}
  button.mark:disabled{opacity:.4;cursor:default}
  .loading{color:var(--muted);font-size:14px;padding:20px 0}
</style>
</head>
<body>
<div class="wrap">
  <h1>Card benefit tracker</h1>
  <div class="sub">Live status from your sheet. Reminders arrive by email automatically.</div>
  <div class="summary" id="summary"></div>
  <div id="cards"><div class="loading">Loading…</div></div>
</div>
<script>
  var DATA = <?= dataJson ?>;
  function render(data){
    var all = data.cards.reduce(function(a,c){return a.concat(c.benefits)},[]);
    var done = all.filter(function(b){return b.done}).length;
    var pending = all.filter(function(b){return !b.done && !b.snoozed}).length;
    document.getElementById('summary').innerHTML =
      stat(all.length,'benefits tracked')+stat(pending,'still to use')+stat(done,'done this period');
    document.getElementById('cards').innerHTML = data.cards.map(function(c){
      return '<div class="card"><div class="card-name">'+esc(c.card)+'</div>'+
        c.benefits.map(function(b){
          var badge = b.done?'<span class="badge b-done">Done</span>'
            :b.snoozed?'<span class="badge b-snooze">Snoozed</span>'
            :'<span class="badge b-pending">To use</span>';
          var btn = b.done?'':'<button class="mark" onclick="mark(\''+b.id+'\',this)">Mark done</button>';
          return '<div class="ben"><div class="ben-info">'+
            '<div class="name'+(b.done?' done':'')+'">'+esc(b.benefit)+' — '+esc(b.amount)+'</div>'+
            '<div class="meta">resets '+esc(b.reset)+' · '+esc(b.category)+'</div></div>'+
            '<div class="ben-right">'+badge+btn+'</div></div>';
        }).join('')+'</div>';
    }).join('');
  }
  function stat(n,l){return '<div class="stat"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
  function esc(s){return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
  function mark(id,btn){btn.disabled=true;btn.textContent='Saving…';
    google.script.run.withSuccessHandler(render).markDoneFromUi(id);}
  render(DATA);
</script>
</body>
</html>
```
