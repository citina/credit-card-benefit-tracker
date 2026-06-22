// Local sanity harness for the credit-card tracker. Run: `node verify.js` from the project root.
// NOT part of the deployed app (Apps Script only loads the .gs/.html files). It parses Code.gs +
// the HTML inline scripts and exercises the pure logic functions under GAS stubs (tz=UTC). No
// Apps Script / network needed. Exit code 1 if anything fails.
const fs = require("fs"), vm = require("vm");
let okAll = true;

// 1) inline HTML JS syntax (Apps Script scriptlets replaced with placeholders so it parses)
for (const f of ["AddCards.html", "Index.html"]) {
  const m = fs.readFileSync(f, "utf8").match(/<script>([\s\S]*?)<\/script>/);
  let js = m[1].replace(/<\?!=\s*\w+\s*\?>/g, '{"cards":[]}').replace(/<\?=\s*\w+\s*\?>/g, "");
  try { new Function(js); console.log(f + ": inline JS OK"); }
  catch (e) { okAll = false; console.log(f + ": JS ERR " + e.message); }
}

// 2) Code.gs STRINGS en/zh symmetry + dangling t_('key') references
const code = fs.readFileSync("Code.gs", "utf8");
const stp = code.indexOf("const STRINGS = {");
let i = code.indexOf("{", stp), depth = 0, end = -1;
for (; i < code.length; i++) { if (code[i] === "{") depth++; else if (code[i] === "}") { depth--; if (depth === 0) { end = i; break; } } }
const STRINGS = eval("(" + code.slice(code.indexOf("{", stp), end + 1) + ")");
const en = Object.keys(STRINGS.en), zh = Object.keys(STRINGS.zh);
const sym = en.length === zh.length && en.every(k => zh.includes(k)); if (!sym) okAll = false;
console.log("STRINGS en/zh:", en.length, "/", zh.length, "symmetric:", sym);
const refs = [...code.matchAll(/t_\('([^']+)'\)/g)].map(m => m[1]);
const dangling = [...new Set(refs)].filter(k => !(k in STRINGS.en)); if (dangling.length) okAll = false;
console.log("dangling quoted t_ keys:", JSON.stringify(dangling));

// 3) load Code.gs under GAS stubs and assert the pure logic
const MM = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], p2 = n => String(n).padStart(2, "0");
function fmt(d, _t, f) { const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
  if (f === 'yyyy') return '' + Y; if (f === 'MM') return p2(M); if (f === 'dd') return p2(D); if (f === 'yyyy-MM') return Y + '-' + p2(M);
  if (f === 'yyyy-MM-dd') return Y + '-' + p2(M) + '-' + p2(D); if (f === 'MMM d') return MM[M - 1] + ' ' + D;
  if (f === 'MMM yyyy') return MM[M - 1] + ' ' + Y; if (f === 'MMM d, yyyy') return MM[M - 1] + ' ' + D + ', ' + Y;
  if (f === 'M月d日') return M + '月' + D + '日'; return Y + '-' + p2(M) + '-' + p2(D); }
let currentSheet = null, currentCards = null, currentCatalog = null;
const sb = {
  Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => 'o@x' }), getActiveUser: () => ({ getEmail: () => 'o@x' }) },
  Utilities: { formatDate: fmt },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (name) => name === 'Catalog' ? currentCatalog : (name === 'Cards' ? currentCards : currentSheet) }) },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  console };
vm.createContext(sb); vm.runInContext(code, sb);
const SR = sb.shouldRemind_, PED = sb.periodEndDate_, DB = sb.daysBetween_, FSD = sb.fmtShortDate_, UC = sb.updateCard, GCR = sb.getCardRows_, U = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const PRD = sb.periodRefreshDate_, SUDN = sb.snoozeUntilDayNumber_, DN = sb.dayNumber_;
const NRD = sb.nextReminderDate_;
const PA = sb.parseAmount_, AFPSY = sb.annualFeePeriodStartYear_, AFRD = sb.annualFeeResetDate_, RAD = sb.realizedAfterDone_, RAU = sb.realizedAfterUndo_;
const DA = sb.displayAmount_;
const PK = sb.periodKey_, PSDN = sb.periodStartDayNumber_, BPB = sb.benefitPeriodBasis_, NA = sb.normalizeAnniversary_;
let pass = 0, fail = 0;
const t = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log("  FAIL " + n + ": got " + JSON.stringify(g) + " exp " + JSON.stringify(e)); } };
// reminders + expiry
t("monthly new midmonth", SR({ reset: 'monthly', lastReminded: null }, U(2026, 6, 15)), true);
t("monthly start-done quiet", SR({ reset: 'monthly', lastReminded: U(2026, 6, 2) }, U(2026, 6, 15)), false);
t("monthly enters expiry", SR({ reset: 'monthly', lastReminded: U(2026, 6, 2) }, U(2026, 6, 27)), true);
t("annual start", SR({ reset: 'annual', lastReminded: null }, U(2026, 1, 1)), true);
t("annual yearend nudge", SR({ reset: 'annual', lastReminded: U(2026, 1, 1) }, U(2026, 12, 10)), true);
t("once first", SR({ reset: 'once', lastReminded: null }, U(2026, 6, 15)), true);
t("monthly daysleft", DB(U(2026, 6, 15), PED('monthly', U(2026, 6, 15))), 15);
t("annual expiry date", FSD(PED('annual', U(2026, 6, 15))), "Dec 31");
t("once no expiry", PED('once', U(2026, 6, 15)), null);
// no literal NUL byte in Code.gs (it once classified the file as binary — review #3)
t("Code.gs has no NUL byte", code.indexOf('\u0000'), -1);
// next-reminder date (drives previewReminders): mid-period → near-expiry nudge; in-window → due now
t("nextReminder monthly midperiod", FSD(NRD({ reset: 'monthly', lastReminded: U(2026, 6, 2) }, U(2026, 6, 15))), "Jun 26");
t("nextReminder monthly due now", FSD(NRD({ reset: 'monthly', lastReminded: U(2026, 6, 2) }, U(2026, 6, 27))), "Jun 27");
t("nextReminder annual midyear", FSD(NRD({ reset: 'annual', lastReminded: U(2026, 1, 1) }, U(2026, 6, 18))), "Dec 2");
t("nextReminder once already sent → null", NRD({ reset: 'once', lastReminded: U(2026, 6, 1) }, U(2026, 6, 15)), null);
// reminder cadence: 'persistent' re-nudges every repeatDays in the expiry window; 'minimal' does not
// monthly window = Jun26..Jun30 (lead 5). First nudge already sent at lr=Jun26.
t("cadence persistent re-nudges (2d)", SR({ reset: 'monthly', lastReminded: U(2026, 6, 26) }, U(2026, 6, 28), 'persistent', 2), true);
t("cadence persistent too soon (1d)", SR({ reset: 'monthly', lastReminded: U(2026, 6, 27) }, U(2026, 6, 28), 'persistent', 2), false);
t("cadence minimal no re-nudge", SR({ reset: 'monthly', lastReminded: U(2026, 6, 26) }, U(2026, 6, 28), 'minimal', 2), false);
t("nextReminder persistent next repeat", FSD(NRD({ reset: 'monthly', lastReminded: U(2026, 6, 26) }, U(2026, 6, 27), 'persistent', 2)), "Jun 28");
t("nextReminder minimal skips to next period", FSD(NRD({ reset: 'monthly', lastReminded: U(2026, 6, 26) }, U(2026, 6, 27), 'minimal', 2)), "Jul 1");
t("nextReminder persistent past window → next period", FSD(NRD({ reset: 'monthly', lastReminded: U(2026, 6, 30) }, U(2026, 6, 30), 'persistent', 2)), "Jul 1");
// #1 refresh date (start of next period, shown on done rows) + #5 snooze clamping (pure helper)
t("refresh monthly", FSD(PRD('monthly', U(2026, 6, 15))), "Jul 1");
t("refresh annual", FSD(PRD('annual', U(2026, 6, 15))), "Jan 1");
t("refresh once null", PRD('once', U(2026, 6, 15)), null);
t("snooze clamps to period end", SUDN('snooze', 'monthly', U(2026, 6, 28), 14) - DN(U(2026, 6, 28)), 2);   // Jun28 +14 → Jun30
t("snoozeEnd lands on period end", SUDN('snoozeEnd', 'monthly', U(2026, 6, 15)) - DN(U(2026, 6, 15)), 15); // Jun15 → Jun30
t("snoozeDate clamped past expiry", SUDN('snoozeDate', 'monthly', U(2026, 6, 15), '2026-07-20') - DN(U(2026, 6, 15)), 15); // → Jun30
t("snoozeDate floored to tomorrow", SUDN('snoozeDate', 'monthly', U(2026, 6, 15), '2026-06-10') - DN(U(2026, 6, 15)), 1);  // past date → +1
t("snooze too late → null", SUDN('snooze', 'monthly', U(2026, 6, 30), 3), null);                          // expires today
// #2 annual-fee bar pure logic — parseAmount_ / period start-year / realized accumulator
t("parseAmount $12.95", PA('$12.95'), 12.95);
t("parseAmount $300", PA('$300'), 300);
t("parseAmount $25", PA('$25'), 25);
t("parseAmount bare 10", PA('10'), 10);
t("parseAmount Unlimited", PA('Unlimited'), null);
t("parseAmount 12 visits", PA('12 visits'), null);     // no $, not a bare number → not 12
// displayAmount_ — email/display $-prefix for bare numbers; leave $-amounts + non-$ text alone
t("displayAmount bare 300 → $300", DA('300'), '$300');
t("displayAmount bare 12.95 → $12.95", DA('12.95'), '$12.95');
t("displayAmount $100 unchanged", DA('$100'), '$100');
t("displayAmount Priority Pass unchanged", DA('Priority Pass'), 'Priority Pass');
t("displayAmount 12 visits unchanged", DA('12 visits'), '12 visits');
t("displayAmount blank unchanged", DA(''), '');
t("afYear after anniversary", AFPSY('2024-06-06', U(2026, 6, 16)), 2026);
t("afYear on anniversary day", AFPSY('2024-06-16', U(2026, 6, 16)), 2026);   // d >= od is inclusive
t("afYear before anniversary", AFPSY('2024-06-06', U(2026, 3, 1)), 2025);
t("afYear blank → calendar", AFPSY('', U(2026, 8, 9)), 2026);
t("feeReset next anniversary", FSD(AFRD('2024-06-06', U(2026, 6, 16))), "Jun 6");   // → 2027-06-06
t("feeReset blank → Jan 1", FSD(AFRD('', U(2026, 6, 16))), "Jan 1");
t("realized same period adds", RAD(60, 2026, 2026, '$10'), { value: 70, period: 2026 });
t("realized cross period resets", RAD(60, 2025, 2026, '$10'), { value: 10, period: 2026 });  // stale base → just this amount
t("realized Unlimited adds 0", RAD(60, 2026, 2026, 'Unlimited'), { value: 60, period: 2026 });
t("undo same period subtracts", RAU(70, 2026, 2026, '$10'), 60);
t("undo floors at 0", RAU(5, 2026, 2026, '$10'), 0);
t("undo other period untouched", RAU(70, 2025, 2026, '$10'), 70);
t("afYear accepts MM-DD", AFPSY('06-06', U(2026, 6, 16)), 2026);
// #1 anniversary normalize (MM-DD; year dropped)
t("normalizeAnniv MM-DD", NA('06-06'), '06-06');
t("normalizeAnniv M-D pads", NA('6-6'), '06-06');
t("normalizeAnniv yyyy-MM-DD legacy", NA('2024-06-06'), '06-06');
t("normalizeAnniv invalid → blank", NA('13-40'), '');
t("normalizeAnniv blank", NA(''), '');
// #3 anniversary-basis period — only 'annual' + basis 'anniversary' shifts off Jan 1
t("periodKey anniversary after anniv", PK('annual', U(2026, 6, 16), 'anniversary', '06-06'), "2026");
t("periodKey anniversary before anniv", PK('annual', U(2026, 3, 1), 'anniversary', '06-06'), "2025");
t("periodKey calendar annual unchanged", PK('annual', U(2026, 6, 16)), "2026");                       // yyyy, no basis
t("periodKey calendar basis stays calendar", PK('annual', U(2026, 6, 16), 'calendar', '06-06'), "2026");
t("periodKey monthly ignores basis", PK('monthly', U(2026, 6, 16), 'anniversary', '06-06'), "2026-06"); // only 'annual' shifts
t("anniv period end date", FSD(PED('annual', U(2026, 6, 16), 'anniversary', '06-06')), "Jun 5");        // day before next anniv
t("anniv refresh date", FSD(PRD('annual', U(2026, 6, 16), 'anniversary', '06-06')), "Jun 6");
t("anniv period start = anniversary", PSDN('annual', U(2026, 6, 16), 'anniversary', '06-06') === DN(U(2026, 6, 6)), true);
t("basis CSR travel = anniversary", BPB('Chase Sapphire Reserve', 'Annual travel credit'), 'anniversary');
t("basis CSP doordash = calendar", BPB('Chase Sapphire Preferred', 'DoorDash credit (DashPass)'), 'calendar');
t("basis unknown card = calendar", BPB('Other Card', 'Foo'), 'calendar');
// updateCard diff + getCardRows suggestions (fake sheet)
function makeSheet(rows) { var grid = rows.map(r => r.slice()); return {
  getLastRow: () => grid.length + 1,
  getRange: function (row, col, nr, nc) { nr = nr || 1; nc = nc || 1; return {
    getValues: function () { var o = []; for (var r = 0; r < nr; r++) { var ln = []; for (var c = 0; c < nc; c++) { var gg = grid[row - 2 + r]; ln.push(gg ? gg[col - 1 + c] : ''); } o.push(ln); } return o; },
    setValues: function (v) { for (var r = 0; r < v.length; r++) { if (!grid[row - 2 + r]) grid[row - 2 + r] = []; for (var c = 0; c < v[r].length; c++) grid[row - 2 + r][col - 1 + c] = v[r][c]; } return this; },
    setValue: function (x) { if (!grid[row - 2]) grid[row - 2] = []; grid[row - 2][col - 1] = x; return this; },
    setNumberFormat: function () { return this; } }; },
  deleteRow: function (idx) { grid.splice(idx - 2, 1); }, _grid: grid }; }
currentSheet = makeSheet([
  ['amex_uber', 'Amex Gold', 'Uber Cash', '$10', 'other', 'monthly', 4, '2026-06', '', ''],
  ['amex_dining', 'Amex Gold', 'Dining credit', '$10', 'dining', 'monthly', 7, '', '', ''],
  ['csr_travel', 'Chase Sapphire Reserve', 'Annual travel', '$300', 'travel', 'annual', 30, '', '', ''],
]);
var res = UC('Amex Gold', [{ id: 'amex_uber', benefit: 'Uber Cash', amount: '$15', category: 'other', reset: 'monthly' }, { benefit: 'Dunkin credit', amount: '$7', category: 'dining', reset: 'monthly' }]);
var g = currentSheet._grid, find = id => g.find(r => r[0] === id) || [];
t("updateCard updated names", res.updated, ['Uber Cash']);   // only the row whose amount actually changed
t("updateCard added names", res.added, ['Dunkin credit']);
t("updateCard removed names", res.removed, ['Dining credit']);
t("updateCard status preserved", find('amex_uber')[7], '2026-06');
t("updateCard dining removed", g.some(r => r[0] === 'amex_dining'), false);
// resubmitting a row unchanged must NOT report it as updated, but must still keep it (the diff fix)
currentSheet = makeSheet([
  ['amex_uber', 'Amex Gold', 'Uber Cash', '$10', 'other', 'monthly', 4, '2026-06', '', ''],
  ['amex_dining', 'Amex Gold', 'Dining credit', '$10', 'dining', 'monthly', 7, '', '', ''],
]);
var res2 = UC('Amex Gold', [
  { id: 'amex_uber', benefit: 'Uber Cash', amount: '$10', category: 'other', reset: 'monthly', reminderDays: 4 },
  { id: 'amex_dining', benefit: 'Dining credit', amount: '$12', category: 'dining', reset: 'monthly', reminderDays: 7 },
]);
t("updateCard unchanged not listed", res2.updated, ['Dining credit']);
t("updateCard unchanged kept", currentSheet._grid.some(r => r[0] === 'amex_uber'), true);
t("updateCard unchanged status preserved", (currentSheet._grid.find(r => r[0] === 'amex_uber') || [])[7], '2026-06');
currentSheet = makeSheet([['amex_uber', 'Amex Gold', 'Uber Cash', '$10', 'other', 'monthly', 4, '', '', '']]);
var gcr = GCR('Amex Gold');
t("getCardRows current count", gcr.benefits.length, 1);
t("getCardRows suggestions count", gcr.suggestions.length, 3);
t("getCardRows custom flag (catalog benefit)", gcr.benefits[0].custom, false);   // Uber Cash is in the Amex Gold catalog
// #5 edit-mode dedup: a new (id-less) row duplicating an existing benefit name is skipped — even when
// it appears BEFORE the resubmitted existing row in the payload (proves the two-pass dedup).
currentSheet = makeSheet([
  ['amex_uber', 'Amex Gold', 'Uber Cash', '$10', 'other', 'monthly', 4, '2026-06', '', ''],
]);
var resd = UC('Amex Gold', [
  { benefit: 'Uber Cash', amount: '$99', category: 'other', reset: 'monthly' },   // new dup, listed first
  { id: 'amex_uber', benefit: 'Uber Cash', amount: '$10', category: 'other', reset: 'monthly', reminderDays: 4 },
]);
t("dedup edit: no dup added", resd.added, []);
t("dedup edit: one Uber Cash row", currentSheet._grid.filter(r => r[1] === 'Amex Gold' && r[2] === 'Uber Cash').length, 1);
t("dedup edit: existing status preserved", (currentSheet._grid.find(r => r[0] === 'amex_uber') || [])[7], '2026-06');

// ----- catalog freshness spine: header migration, header-based reads, stale-date parsing -----
const GCD = sb.getCatalogData_, EH = sb.ensureHeaders_, MSV = sb.monthsSinceVerified_, CS = sb.catalogStale_;
const CAT_H = ['Card','LastVerified','Benefit','Amount','Category','Reset','ReminderDays','SourceUrl','PeriodBasis','Notes'];
// Catalog sheet stub: rows[0] is the header (row 1), rows[1..] are data; getRange is 1-indexed and
// reads the header row too (unlike makeSheet, which models only data rows).
function makeCatalogSheet(rows) {
  var grid = rows.map(r => r.slice());
  return {
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getRange: function (row, col, nr, nc) { nr = nr || 1; nc = nc || 1; return {
      getValues: function () { var o = []; for (var r = 0; r < nr; r++) { var ln = []; for (var c = 0; c < nc; c++) { var gg = grid[row - 1 + r]; ln.push(gg && gg[col - 1 + c] != null ? gg[col - 1 + c] : ''); } o.push(ln); } return o; },
      setValues: function (v) { for (var r = 0; r < v.length; r++) { if (!grid[row - 1 + r]) grid[row - 1 + r] = []; for (var c = 0; c < v[r].length; c++) grid[row - 1 + r][col - 1 + c] = v[r][c]; } return this; },
      setFontWeight: function () { return this; }, setFrozenRows: function () { return this; }, setNumberFormat: function () { return this; } }; },
    setFrozenRows: function () { return this; }, autoResizeColumns: function () { return this; }, _grid: grid };
}
// ensureHeaders_: append missing columns to the right, preserve header + data, idempotent (PITFALLS #2)
var catMig = makeCatalogSheet([
  ['Card','LastVerified','Benefit','Amount','Category','Reset','ReminderDays'],
  ['Amex Gold','2026-06','Uber Cash','$10','other','monthly',4],
]);
t("ensureHeaders appends missing", EH(catMig, CAT_H), CAT_H);
t("ensureHeaders migrates header row", catMig._grid[0], CAT_H);
t("ensureHeaders preserves data row", catMig._grid[1], ['Amex Gold','2026-06','Uber Cash','$10','other','monthly',4]);
t("ensureHeaders idempotent", EH(catMig, CAT_H), CAT_H);
// getCatalogData_ reads by header NAME: old 7-col parses with defaults
currentCatalog = makeCatalogSheet([
  ['Card','LastVerified','Benefit','Amount','Category','Reset','ReminderDays'],
  ['Amex Gold','2026-06','Uber Cash','$10','other','monthly',4],
]);
var c7 = GCD().cards;
t("catalog 7-col one card", c7.length, 1);
t("catalog 7-col lastVerified", c7[0].lastVerified, '2026-06');
t("catalog 7-col periodBasis default", c7[0].benefits[0].periodBasis, 'calendar');
t("catalog 7-col sourceUrl default", c7[0].benefits[0].sourceUrl, '');
// new 10-col parses the appended fields
currentCatalog = makeCatalogSheet([
  CAT_H.slice(),
  ['CSR','2026-01','Annual travel','$300','travel','annual',30,'https://chase.com/x','anniversary','enroll first'],
]);
var c10 = GCD().cards;
t("catalog 10-col sourceUrl", c10[0].benefits[0].sourceUrl, 'https://chase.com/x');
t("catalog 10-col periodBasis", c10[0].benefits[0].periodBasis, 'anniversary');
t("catalog 10-col notes", c10[0].benefits[0].notes, 'enroll first');
t("catalog 10-col card sourceUrl propagated", c10[0].sourceUrl, 'https://chase.com/x');
t("catalog 10-col card lastVerifiedLabel", c10[0].lastVerifiedLabel, 'Jan 2026');
// a LastVerified cell coerced to a Date by Sheets still normalizes + labels
currentCatalog = makeCatalogSheet([
  CAT_H.slice(),
  ['Amex Gold', U(2026, 1, 1), 'Uber Cash', '$10', 'other', 'monthly', 4, '', 'calendar', ''],
]);
var cDate = GCD().cards;
t("catalog coerced-Date canonical", cDate[0].lastVerified, '2026-01');
t("catalog coerced-Date label", cDate[0].lastVerifiedLabel, 'Jan 2026');
// header-based read is column-order independent
currentCatalog = makeCatalogSheet([
  ['Benefit','Card','PeriodBasis','Amount','Reset','Category','ReminderDays','Notes','LastVerified','SourceUrl'],
  ['Annual travel','CSR','anniversary','$300','annual','travel',30,'note','2025-12','https://x'],
]);
var cR = GCD().cards;
t("catalog reordered cols read by name", [cR[0].card, cR[0].benefits[0].periodBasis, cR[0].benefits[0].reset], ['CSR','anniversary','annual']);
currentCatalog = null;
// verifiedKey_ / verifiedLabel_: robust to Sheets coercing 'YYYY-MM' into a Date
const VK = sb.verifiedKey_, VL = sb.verifiedLabel_;
t("verifiedKey passes string", VK('2026-06'), '2026-06');
t("verifiedKey from Date → yyyy-MM", VK(U(2026, 6, 1)), '2026-06');
t("verifiedKey invalid → blank", VK('soon'), '');
t("verifiedLabel YYYY-MM", VL('2026-06'), 'Jun 2026');
t("verifiedLabel YYYY-MM-DD adds day", VL('2026-06-01'), 'Jun 1, 2026');
t("verifiedLabel from Date", VL(U(2026, 6, 1)), 'Jun 2026');
t("verifiedLabel blank", VL(''), '');
// stale-date parsing: YYYY-MM and YYYY-MM-DD; coerced Date; unparseable/blank → not stale
t("monthsSince YYYY-MM", MSV('2026-01', U(2026, 6, 18)), 5);
t("monthsSince YYYY-MM-DD ignores day", MSV('2025-12-31', U(2026, 6, 18)), 6);
t("monthsSince from coerced Date", MSV(U(2025, 12, 1), U(2026, 6, 18)), 6);
t("monthsSince unparseable null", MSV('soon', U(2026, 6, 18)), null);
t("catalogStale fresh (5mo) false", CS('2026-01', U(2026, 6, 18)), false);
t("catalogStale old (6mo) true", CS('2025-12', U(2026, 6, 18)), true);
t("catalogStale blank not flagged", CS('', U(2026, 6, 18)), false);
// reviewStaleCatalog selection (pure): only cards past the threshold, blank dates excluded
t("staleCatalogCards filters by date",
  sb.staleCatalogCards_([{ card: 'A', lastVerified: '2025-12' }, { card: 'B', lastVerified: '2026-06' }, { card: 'C', lastVerified: '' }], U(2026, 6, 18)).map(c => c.card),
  ['A']);
// appendMissingCatalog_: re-running setup() adds newly-shipped catalog cards (append-only, idempotent)
var apSheet = makeCatalogSheet([CAT_H.slice()]);  // header only
sb.appendMissingCatalog_(apSheet);
var apCards = apSheet._grid.slice(1).map(r => r[0]);
t("appendMissingCatalog adds a new card", apCards.indexOf('Capital One Venture X') !== -1, true);
var apN = apSheet._grid.length;
sb.appendMissingCatalog_(apSheet);
t("appendMissingCatalog idempotent", apSheet._grid.length, apN);
var apSheet2 = makeCatalogSheet([CAT_H.slice(), ['Amex Gold', '2026-06', 'Uber Cash', '$10', 'other', 'monthly', 4, '', 'calendar', '']]);
sb.appendMissingCatalog_(apSheet2);
t("appendMissingCatalog keeps existing unique", apSheet2._grid.slice(1).filter(r => r[0] === 'Amex Gold' && r[2] === 'Uber Cash').length, 1);
console.log("logic asserts: " + pass + " passed, " + fail + " failed");
if (fail || !okAll) process.exitCode = 1;
