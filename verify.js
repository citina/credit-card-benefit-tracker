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
const PA = sb.parseAmount_, AFPSY = sb.annualFeePeriodStartYear_, AFRD = sb.annualFeeResetDate_, RASU = sb.realizedAfterSetUsed_;
const DA = sb.displayAmount_;
const PK = sb.periodKey_, PSDN = sb.periodStartDayNumber_, BPB = sb.benefitPeriodBasis_, NA = sb.normalizeAnniversary_;
const NSB = sb.normalizeStoredBasis_, RR = sb.readRows_;   // #C persisted-basis read
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
// #I/#J realizedAfterSetUsed_ — the single accumulator behind done/undo/partial/value-on-use.
// prev = {realizedValue, realizedPeriod, usedValue, usedPeriod}; result mirrors it.
const P = (rv, rp, uv, up) => ({ realizedValue: rv, realizedPeriod: rp, usedValue: uv, usedPeriod: up });
t("setUsed done fresh adds", RASU(P(60, 2026, 0, ''), 2026, '2026-06', 10), P(70, 2026, 10, '2026-06'));
t("setUsed cross fee period resets", RASU(P(60, 2025, 0, ''), 2026, '2026-06', 10), P(10, 2026, 10, '2026-06'));  // stale base → 0
t("setUsed value-on-use 0 adds nothing", RASU(P(60, 2026, 0, ''), 2026, '2026-06', 0), P(60, 2026, 0, '2026-06'));
t("setUsed revise partial backs out prior", RASU(P(65, 2026, 5, '2026-06'), 2026, '2026-06', 8), P(68, 2026, 8, '2026-06'));  // 65-5+8
t("setUsed done after partial = full no double-count", RASU(P(65, 2026, 5, '2026-06'), 2026, '2026-06', 10), P(70, 2026, 10, '2026-06'));
t("setUsed undo (0) backs out current sub-period", RASU(P(70, 2026, 10, '2026-06'), 2026, '2026-06', 0), P(60, 2026, 0, '2026-06'));
t("setUsed undo floors at 0", RASU(P(5, 2026, 10, '2026-06'), 2026, '2026-06', 0), P(0, 2026, 0, '2026-06'));
t("setUsed prior sub-period stays locked", RASU(P(30, 2026, 10, '2026-05'), 2026, '2026-06', 10), P(40, 2026, 10, '2026-06'));  // May $10 locked in 30
t("setUsed negative clamps to 0", RASU(P(60, 2026, 0, ''), 2026, '2026-06', -5), P(60, 2026, 0, '2026-06'));
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

// ----- #C persist PeriodBasis into Benefits: normalize, backfill, write-through, read precedence -----
// normalizeStoredBasis_: preserves blank (= "derive by name"), unlike normalizeBasis_ which defaults calendar
t("storedBasis anniversary", NSB('anniversary'), 'anniversary');
t("storedBasis calendar kept", NSB('calendar'), 'calendar');
t("storedBasis blank stays blank", NSB(''), '');
t("storedBasis garbage → blank", NSB('weekly'), '');
// backfillPeriodBasis_: stamp only blank cells that DERIVE to anniversary; leave calendar blank; keep set cells
var bfSheet = makeSheet([
  ['csr_travel', 'Chase Sapphire Reserve', 'Annual travel credit', '$300', 'travel', 'annual', 14, '', '', ''], // derives anniversary → stamp
  ['amex_uber', 'Amex Gold', 'Uber Cash', '$10', 'other', 'monthly', 4, '', '', ''],                            // derives calendar → leave blank
  ['x', 'Some Card', 'Whatever', '$5', 'other', 'monthly', 7, '', '', '', '', '', 'anniversary'],               // already set → untouched
]);
t("backfill count", sb.backfillPeriodBasis_(bfSheet), 1);
t("backfill stamps anniversary", bfSheet._grid[0][12], 'anniversary');
t("backfill leaves calendar blank", NSB(bfSheet._grid[1][12]), '');   // stub gives undefined; real Sheets ''
t("backfill keeps existing set", bfSheet._grid[2][12], 'anniversary');
t("backfill idempotent", sb.backfillPeriodBasis_(bfSheet), 0);
// updateCard appends persist an anniversary basis (calendar/manual → blank) + leave Used* blank
currentSheet = makeSheet([['amex_uber', 'Amex Gold', 'Uber Cash', '$10', 'other', 'monthly', 4, '2026-06', '', '']]);
UC('Amex Gold', [
  { id: 'amex_uber', benefit: 'Uber Cash', amount: '$10', category: 'other', reset: 'monthly', reminderDays: 4 },
  { benefit: 'Annual travel', amount: '$300', category: 'travel', reset: 'annual', reminderDays: 30, periodBasis: 'anniversary' },
  { benefit: 'Lounge perk', amount: '$5', category: 'other', reset: 'monthly', periodBasis: 'calendar' },
]);
var gPB = currentSheet._grid, byBen = nm => gPB.find(r => r[2] === nm) || [];
t("updateCard persists anniversary basis", byBen('Annual travel')[12], 'anniversary');
t("updateCard calendar basis blank", byBen('Lounge perk')[12], '');
t("updateCard new-row Used* blank", [byBen('Annual travel')[13], byBen('Annual travel')[14]], ['', '']);
// readRows_ precedence: a stored basis wins over derive-by-name; blank falls back to derivation
currentCards = null;
currentSheet = makeSheet([
  ['a', 'Chase Sapphire Reserve', 'Annual travel credit', '$300', 'travel', 'annual', 30, '', '', '', '', '', 'calendar'], // stored overrides derive-anniversary
  ['b', 'Chase Sapphire Reserve', 'Annual travel credit', '$300', 'travel', 'annual', 30, '', '', '', '', '', ''],         // blank → derive anniversary
]);
var rrRows = RR().rows;
t("readRows stored basis wins", rrRows[0].periodBasis, 'calendar');
t("readRows blank basis derives", rrRows[1].periodBasis, 'anniversary');
t("readRows reads usedValue/usedPeriod blank → 0/''", [rrRows[0].usedValue, rrRows[0].usedPeriod], [0, '']);
currentSheet = null;

// ----- catalog freshness spine: header migration, header-based reads, stale-date parsing -----
const GCD = sb.getCatalogData_, EH = sb.ensureHeaders_, MSV = sb.monthsSinceVerified_, CS = sb.catalogStale_;
const CAT_H = ['Card','LastVerified','Benefit','Amount','Category','Reset','ReminderDays','SourceUrl','PeriodBasis','Notes','Issuer'];
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
t("catalog 7-col annualFee from constant", c7[0].annualFee, 325);  // Amex Gold fee comes from CATALOG (sheet has no fee col)
t("catalog 7-col issuer falls back to constant", c7[0].issuer, 'American Express');
t("catalog 7-col periodBasis default", c7[0].benefits[0].periodBasis, 'calendar');
t("catalog 7-col sourceUrl default", c7[0].benefits[0].sourceUrl, '');
// new 11-col parses the appended fields
currentCatalog = makeCatalogSheet([
  CAT_H.slice(),
  ['CSR','2026-01','Annual travel','$300','travel','annual',30,'https://chase.com/x','anniversary','enroll first','Chase'],
]);
var c11 = GCD().cards;
t("catalog 11-col sourceUrl", c11[0].benefits[0].sourceUrl, 'https://chase.com/x');
t("catalog 11-col periodBasis", c11[0].benefits[0].periodBasis, 'anniversary');
t("catalog 11-col notes", c11[0].benefits[0].notes, 'enroll first');
t("catalog 11-col issuer", c11[0].issuer, 'Chase');
t("catalog 11-col card sourceUrl propagated", c11[0].sourceUrl, 'https://chase.com/x');
t("catalog 11-col card lastVerifiedLabel", c11[0].lastVerifiedLabel, 'Jan 2026');
t("catalog unknown card annualFee 0", c11[0].annualFee, 0);  // 'CSR' isn't a CATALOG key → fee defaults to 0
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
  ['Benefit','Card','PeriodBasis','Amount','Reset','Category','ReminderDays','Notes','LastVerified','SourceUrl','Issuer'],
  ['Annual travel','CSR','anniversary','$300','annual','travel',30,'note','2025-12','https://x','Chase'],
]);
var cR = GCD().cards;
t("catalog reordered cols read by name", [cR[0].card, cR[0].issuer, cR[0].benefits[0].periodBasis, cR[0].benefits[0].reset], ['CSR','Chase','anniversary','annual']);
currentCatalog = null;
// fallback path (no Catalog sheet): cards come from the CATALOG constant — each carries a numeric annualFee
var cFallback = GCD().cards;
t("catalog fallback every card has numeric annualFee", cFallback.every(c => typeof c.annualFee === 'number'), true);
t("catalog fallback every card has issuer field", cFallback.every(c => Object.prototype.hasOwnProperty.call(c, 'issuer')), true);
t("catalog fallback every card has nonblank issuer", cFallback.every(c => !!c.issuer), true);
t("catalog fallback Amex Gold fee", (cFallback.find(c => c.card === 'Amex Gold') || {}).annualFee, 325);
t("catalog fallback Amex Platinum fee", (cFallback.find(c => c.card === 'Amex Platinum') || {}).annualFee, 895);
var platCat = cFallback.find(c => c.card === 'Amex Platinum') || { benefits: [] };
t("catalog Amex Platinum refreshed benefits", platCat.benefits.map(b => b.benefit), [
  'Uber Cash',
  'Digital entertainment credit',
  'Walmart+ membership',
  'Resy dining credit',
  'Lululemon credit',
  'Hotel credit (FHR / Hotel Coll.)',
  'Airline fee credit',
  'CLEAR Plus credit',
  'Oura Ring credit',
  'Equinox credit',
]);
var brilliantCat = cFallback.find(c => c.card === 'Marriott Bonvoy Brilliant') || { benefits: [] };
var brilliantFna = brilliantCat.benefits.find(b => b.benefit === 'Annual free night award') || {};
t("catalog Brilliant has free-night value-on-use", [brilliantFna.amount, brilliantFna.periodBasis], ['Free night', 'anniversary']);
var hiltonCat = cFallback.find(c => c.card === 'Hilton Honors Aspire') || { benefits: [] };
t("catalog Hilton Aspire credits split", hiltonCat.benefits.map(b => [b.benefit, b.amount, b.reset]), [
  ['Hilton resort credit', '$200', 'semiannual'],
  ['Flight credit', '$50', 'quarterly'],
  ['CLEAR Plus credit', '$209', 'annual'],
  ['Annual free night reward', 'Free night', 'annual'],
]);
var deltaCat = cFallback.find(c => c.card === 'Delta SkyMiles Reserve') || { benefits: [] };
var deltaCert = deltaCat.benefits.find(b => b.benefit === 'Companion Certificate') || {};
t("catalog Delta companion value-on-use", [deltaCert.amount, deltaCert.periodBasis], ['Companion certificate', 'anniversary']);
var bizCat = cFallback.find(c => c.card === 'Amex Business Platinum') || { benefits: [] };
t("catalog Business Platinum split credits", bizCat.benefits.map(b => [b.benefit, b.amount, b.reset]), [
  ['Hotel credit (FHR / Hotel Coll.)', '$300', 'semiannual'],
  ['Hilton credit', '$50', 'quarterly'],
  ['Airline fee credit', '$200', 'annual'],
  ['CLEAR Plus credit', '$209', 'annual'],
  ['Dell Technologies credit', '$150', 'annual'],
  ['ChatGPT Business credit', '$300', 'annual'],
  ['Adobe credit', '$250', 'annual'],
  ['Indeed credit', '$90', 'quarterly'],
  ['Wireless credit', '$10', 'monthly'],
]);
// verifiedKey_ / verifiedLabel_: robust to Sheets coercing 'YYYY-MM' into a Date
const VK = sb.verifiedKey_, VL = sb.verifiedLabel_;
t("verifiedKey passes string", VK('2026-06'), '2026-06');
t("verifiedKey from Date → yyyy-MM", VK(U(2026, 6, 1)), '2026-06');
t("verifiedKey invalid → blank", VK('soon'), '');
t("verifiedLabel YYYY-MM", VL('2026-06'), 'Jun 2026');
t("verifiedLabel YYYY-MM-DD adds day", VL('2026-06-01'), 'Jun 1, 2026');
t("verifiedLabel from Date", VL(U(2026, 6, 1)), 'Jun 2026');
t("verifiedLabel blank", VL(''), '');
// verifiedDayUpgrade_: month-only → constant's day, guarded (never clobbers a hand-entered day / other month)
const VDU = sb.verifiedDayUpgrade_;
t("upgrade month-only → full day", VDU('2026-06', '2026-06-19'), '2026-06-19');
t("upgrade preserves existing day", VDU('2026-06-15', '2026-06-19'), '');
t("upgrade skips different month", VDU('2026-07', '2026-06-19'), '');
t("upgrade skips blank", VDU('', '2026-06-19'), '');
t("upgrade skips unparseable", VDU('soon', '2026-06-19'), '');
t("upgrade coerced-Date month-only → full", VDU(U(2026, 6, 1), '2026-06-19'), '2026-06-19');
t("upgrade idempotent (already day)", VDU('2026-06-19', '2026-06-19'), '');
t("upgrade needs day-precise constant", VDU('2026-06', '2026-06'), '');
// restampCatalogDay(): in-place upgrade of an existing sheet — only matching month-only cells, never user days / unknown cards
currentCatalog = makeCatalogSheet([
  CAT_H.slice(),
  ['Amex Gold', '2026-06', 'Uber Cash', '$10', 'other', 'monthly', 4, '', 'calendar', ''],          // month-only → upgrades
  ['Amex Gold', '2026-06-15', 'Dining credit', '$10', 'dining', 'monthly', 7, '', 'calendar', ''],   // hand-entered day → preserved
  ['Totally Unknown Card', '2026-06', 'X', '$5', 'other', 'monthly', 7, '', 'calendar', ''],          // not in CATALOG → skipped
]);
const restampN = sb.restampCatalogDay();
t("restamp count", restampN, 1);
t("restamp upgrades month-only", currentCatalog._grid[1][1], '2026-06-24');
t("restamp preserves user day", currentCatalog._grid[2][1], '2026-06-15');
t("restamp skips unknown card", currentCatalog._grid[3][1], '2026-06');
t("restamp idempotent (2nd run no-op)", sb.restampCatalogDay(), 0);
currentCatalog = null;
// shipped CATALOG constant is now day-precise everywhere (verified via the fallback path)
var cDay = GCD().cards;
t("catalog constant all day-precise", cDay.every(c => /^\d{4}-\d{2}-\d{2}$/.test(c.lastVerified)), true);
t("catalog constant label shows day", (cDay.find(c => c.card === 'Amex Gold') || {}).lastVerifiedLabel, 'Jun 24, 2026');
// syncCatalogRowsFromConstant_(): opt-in editor-run helper for refreshing existing Catalog rows
// after an accepted audit. It updates matching card+benefit rows by header name, without deleting rows.
var syncSheet = makeCatalogSheet([
  CAT_H.slice(),
  ['Chase Sapphire Reserve', '2026-06-19', 'The Edit hotel credit', '$250', 'hotel', 'semiannual', 30, '', 'calendar', '', ''],
  ['Chase Sapphire Reserve', '2026-06-19', 'Peloton credit', '$120', 'other', 'annual', 30, '', 'calendar', '', ''],
  ['Manual Card', '2026-01-01', 'Manual benefit', '$1', 'other', 'monthly', 7, '', 'calendar', 'keep me', ''],
]);
const syncN = sb.syncCatalogRowsFromConstant_(syncSheet);
t("syncCatalog updates matching rows count", syncN, 2);
t("syncCatalog refreshes The Edit amount/reset", [syncSheet._grid[1][1], syncSheet._grid[1][3], syncSheet._grid[1][5], syncSheet._grid[1][10]], ['2026-06-24', '$500', 'annual', 'Chase']);
t("syncCatalog refreshes Peloton amount/reset", [syncSheet._grid[2][3], syncSheet._grid[2][5], syncSheet._grid[2][6]], ['$10', 'monthly', 7]);
t("syncCatalog leaves unknown rows alone", syncSheet._grid[3], ['Manual Card', '2026-01-01', 'Manual benefit', '$1', 'other', 'monthly', 7, '', 'calendar', 'keep me', '']);
// syncCardFeesFromConstant_(): opt-in Cards-sheet annual-fee refresh. Dashboard reads Cards, so
// catalog fee changes need this helper for already-added cards.
var feeSheet = makeSheet([
  ['Amex Platinum', 695, '06-01', 12, '2026'],
  ['Manual Card', 123, '01-01', 0, ''],
]);
t("syncCardFees count", sb.syncCardFeesFromConstant_(feeSheet), 1);
t("syncCardFees updates Platinum fee", feeSheet._grid[0], ['Amex Platinum', 895, '06-01', 12, '2026']);
t("syncCardFees leaves unknown card", feeSheet._grid[1], ['Manual Card', 123, '01-01', 0, '']);
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
t("appendMissingCatalog adds audited cards", ['Hilton Honors Aspire','Delta SkyMiles Reserve','Amex Business Platinum'].every(c => apCards.indexOf(c) !== -1), true);
var apBizWireless = apSheet._grid.find(r => r[0] === 'Amex Business Platinum' && r[2] === 'Wireless credit') || [];
t("appendMissingCatalog writes issuer for appended rows", apBizWireless[10], 'American Express');
var apN = apSheet._grid.length;
sb.appendMissingCatalog_(apSheet);
t("appendMissingCatalog idempotent", apSheet._grid.length, apN);
var apSheet2 = makeCatalogSheet([CAT_H.slice(), ['Amex Gold', '2026-06', 'Uber Cash', '$10', 'other', 'monthly', 4, '', 'calendar', '']]);
sb.appendMissingCatalog_(apSheet2);
t("appendMissingCatalog keeps existing unique", apSheet2._grid.slice(1).filter(r => r[0] === 'Amex Gold' && r[2] === 'Uber Cash').length, 1);
// webAppUrl_(): the WEBAPP_URL Script Property (trimmed) wins; unset/blank falls back to
// getService().getUrl(). The two stubs are removed afterwards so the sandbox stays as before.
var wuProps = {};
sb.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k in wuProps ? wuProps[k] : null) }) };
sb.ScriptApp = { getService: () => ({ getUrl: () => 'https://fallback/exec' }) };
wuProps = { WEBAPP_URL: ' https://pinned/exec ' };
t("webAppUrl_ prefers the Script Property (trimmed)", sb.webAppUrl_(), 'https://pinned/exec');
wuProps = { WEBAPP_URL: '   ' };
t("webAppUrl_ blank property falls back", sb.webAppUrl_(), 'https://fallback/exec');
wuProps = {};
t("webAppUrl_ unset property falls back", sb.webAppUrl_(), 'https://fallback/exec');
delete sb.PropertiesService; delete sb.ScriptApp;
console.log("logic asserts: " + pass + " passed, " + fail + " failed");
if (fail || !okAll) process.exitCode = 1;
