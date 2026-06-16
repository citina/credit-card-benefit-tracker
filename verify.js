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
  if (f === 'yyyy') return '' + Y; if (f === 'MM') return p2(M); if (f === 'yyyy-MM') return Y + '-' + p2(M);
  if (f === 'yyyy-MM-dd') return Y + '-' + p2(M) + '-' + p2(D); if (f === 'MMM d') return MM[M - 1] + ' ' + D;
  if (f === 'M月d日') return M + '月' + D + '日'; return Y + '-' + p2(M) + '-' + p2(D); }
let currentSheet = null;
const sb = {
  Session: { getScriptTimeZone: () => 'UTC', getEffectiveUser: () => ({ getEmail: () => 'o@x' }), getActiveUser: () => ({ getEmail: () => 'o@x' }) },
  Utilities: { formatDate: fmt },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (name) => name === 'Catalog' ? null : currentSheet }) },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  console };
vm.createContext(sb); vm.runInContext(code, sb);
const SR = sb.shouldRemind_, PED = sb.periodEndDate_, DB = sb.daysBetween_, FSD = sb.fmtShortDate_, UC = sb.updateCard, GCR = sb.getCardRows_, U = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const PRD = sb.periodRefreshDate_, SUDN = sb.snoozeUntilDayNumber_, DN = sb.dayNumber_;
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
// #1 refresh date (start of next period, shown on done rows) + #5 snooze clamping (pure helper)
t("refresh monthly", FSD(PRD('monthly', U(2026, 6, 15))), "Jul 1");
t("refresh annual", FSD(PRD('annual', U(2026, 6, 15))), "Jan 1");
t("refresh once null", PRD('once', U(2026, 6, 15)), null);
t("snooze clamps to period end", SUDN('snooze', 'monthly', U(2026, 6, 28), 14) - DN(U(2026, 6, 28)), 2);   // Jun28 +14 → Jun30
t("snoozeEnd lands on period end", SUDN('snoozeEnd', 'monthly', U(2026, 6, 15)) - DN(U(2026, 6, 15)), 15); // Jun15 → Jun30
t("snoozeDate clamped past expiry", SUDN('snoozeDate', 'monthly', U(2026, 6, 15), '2026-07-20') - DN(U(2026, 6, 15)), 15); // → Jun30
t("snoozeDate floored to tomorrow", SUDN('snoozeDate', 'monthly', U(2026, 6, 15), '2026-06-10') - DN(U(2026, 6, 15)), 1);  // past date → +1
t("snooze too late → null", SUDN('snooze', 'monthly', U(2026, 6, 30), 3), null);                          // expires today
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
console.log("logic asserts: " + pass + " passed, " + fail + " failed");
if (fail || !okAll) process.exitCode = 1;
