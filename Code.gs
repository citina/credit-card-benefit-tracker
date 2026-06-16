/**
 * Credit Card Benefit Tracker — Apps Script engine.
 * See BUILD_SPEC.md. Deploy as a Web App: execute as Me, access "Only myself".
 */

// ----------------------------- CONFIG -----------------------------
const CONFIG = {
  EMAIL: Session.getEffectiveUser().getEmail(),  // owner; reminders are sent here
  LANG: 'en',                                     // 'en' | 'zh'
  AUTHORIZED_EMAILS: [],                          // empty = owner-only. Only meaningful in "Anyone" access (Workspace).
  TOKEN: 'CHANGE_ME_to_a_long_random_string',    // defense-in-depth; required only in "Anyone" sharing mode
  DEFAULT_REMINDER_DAYS: 4,
  SNOOZE_DEFAULT_DAYS: 3,
  DAILY_HOUR: 9,                                  // 24h, script timezone
  SHEET_NAME: 'Benefits',
  CATALOG_SHEET: 'Catalog',                       // editable benefit catalog the Add-cards wizard reads
};

// ----------------------------- SCHEMA -----------------------------
const COL = {
  ID: 1, CARD: 2, BENEFIT: 3, AMOUNT: 4, CATEGORY: 5,
  RESET: 6, REMINDER_DAYS: 7, LAST_DONE_PERIOD: 8,
  LAST_REMINDED: 9, SNOOZE_UNTIL: 10,
};
const HEADERS = ['ID', 'Card', 'Benefit', 'Amount', 'Category', 'Reset',
                 'ReminderDays', 'LastDonePeriod', 'LastReminded', 'SnoozeUntil'];
const SNOOZE_PRESETS = [1, 3, 7, 14];  // dashboard snooze choices (days), filtered by expiry

// Category is a closed set; the wizard offers exactly these and addBenefits() coerces anything
// unknown to 'other'. Keep in sync with the dropdown built from addUiStrings_().catLabels.
const CATEGORIES = ['travel', 'dining', 'hotel', 'streaming', 'grocery', 'lounge', 'other'];

// ----------------------------- CATALOG -----------------------------
// Pre-researched recurring benefits, shipped in code so every friend's copy gets them.
// setupCatalog() seeds these into an editable `Catalog` sheet on first run; the wizard reads
// that sheet if present, else this constant (see getCatalogData_()). Each benefit maps 1:1 to
// the Benefits schema minus ID (generated on add). `reset` ∈ monthly/quarterly/semiannual/annual/
// once; `category` ∈ CATEGORIES. These are USE-IT-OR-LOSE-IT recurring credits only — not
// multipliers, sign-up bonuses, or every-few-years perks (Global Entry etc.).
//
// FRESHNESS: amounts/cadence verified 2026-06 via issuer + reporting. Card terms change; the
// wizard shows lastVerified + a "verify with your issuer" note, and manual-add covers the rest.
const CATALOG = {
  'Chase Sapphire Preferred': {
    lastVerified: '2026-06',
    benefits: [
      // Chase Travel hotel credit doubled to $100/anniversary year effective 2026-06-15.
      // ANNIVERSARY-year reset (cardmember year, NOT calendar) — verified 2026-06. The period math
      // currently treats 'annual' as calendar, so the reset/expiry date is wrong for non-January
      // opens; see backlog #3 (per-benefit periodBasis + card open date).
      { benefit: 'Hotel credit (Chase Travel)', amount: '$100', category: 'hotel',  reset: 'annual',  reminderDays: 30 },
      { benefit: 'DoorDash credit (DashPass)',  amount: '$10',  category: 'dining', reset: 'monthly', reminderDays: 7 },
    ],
  },
  'Amex Gold': {
    lastVerified: '2026-06',
    benefits: [
      { benefit: 'Uber Cash',     amount: '$10', category: 'other',  reset: 'monthly',    reminderDays: 4 },
      { benefit: 'Dining credit', amount: '$10', category: 'dining', reset: 'monthly',    reminderDays: 7 },  // Grubhub, Five Guys, Cheesecake Factory, etc.
      { benefit: 'Dunkin credit', amount: '$7',  category: 'dining', reset: 'monthly',    reminderDays: 7 },
      { benefit: 'Resy credit',   amount: '$50', category: 'dining', reset: 'semiannual', reminderDays: 21 }, // $50 H1 + $50 H2
    ],
  },
  'Amex Platinum': {
    lastVerified: '2026-06',
    benefits: [
      { benefit: 'Uber Cash',                       amount: '$15',    category: 'other',     reset: 'monthly',    reminderDays: 4 },  // +$20 bonus in December
      { benefit: 'Digital entertainment credit',    amount: '$25',    category: 'streaming', reset: 'monthly',    reminderDays: 7 },  // Disney+, Hulu, NYT, Peacock, WSJ, etc.
      { benefit: 'Walmart+ membership',             amount: '$12.95', category: 'other',     reset: 'monthly',    reminderDays: 7 },
      { benefit: 'Resy dining credit',              amount: '$100',   category: 'dining',    reset: 'quarterly',  reminderDays: 21 },
      { benefit: 'Lululemon credit',                amount: '$75',    category: 'other',     reset: 'quarterly',  reminderDays: 21 },
      { benefit: 'Hotel credit (FHR / Hotel Coll.)', amount: '$300',  category: 'hotel',     reset: 'semiannual', reminderDays: 30 },
      { benefit: 'Airline fee credit',              amount: '$200',   category: 'travel',    reset: 'annual',     reminderDays: 30 },
      { benefit: 'CLEAR Plus credit',               amount: '$209',   category: 'travel',    reset: 'annual',     reminderDays: 30 },
      { benefit: 'Oura Ring credit',                amount: '$200',   category: 'other',     reset: 'annual',     reminderDays: 30 },
    ],
  },
  'Chase Sapphire Reserve': {
    lastVerified: '2026-06',
    benefits: [
      { benefit: 'Dining credit (Exclusive Tables)', amount: '$150', category: 'dining',  reset: 'semiannual', reminderDays: 21 }, // OpenTable; $150 H1 + $150 H2
      { benefit: 'The Edit hotel credit',            amount: '$250', category: 'hotel',   reset: 'semiannual', reminderDays: 30 },
      { benefit: 'StubHub / viagogo credit',         amount: '$150', category: 'other',   reset: 'semiannual', reminderDays: 21 },
      { benefit: 'DoorDash credit (DashPass)',       amount: '$25',  category: 'dining',  reset: 'monthly',    reminderDays: 7 },  // $5 restaurant + 2×$10 non-restaurant
      { benefit: 'Lyft credit',                      amount: '$10',  category: 'travel',  reset: 'monthly',    reminderDays: 7 },
      { benefit: 'Peloton credit',                   amount: '$120', category: 'other',   reset: 'annual',     reminderDays: 30 },
      // ANNIVERSARY-year reset (account anniversary, NOT calendar) — verified 2026-06. See backlog #3.
      { benefit: 'Annual travel credit',             amount: '$300', category: 'travel',  reset: 'annual',     reminderDays: 30 },
    ],
  },
};
const CATALOG_HEADERS = ['Card', 'LastVerified', 'Benefit', 'Amount', 'Category', 'Reset', 'ReminderDays'];

// ----------------------------- STRINGS (i18n) -----------------------------
// All user-facing text lives here. Add a language = add a block. {placeholders} via fmt_().
const STRINGS = {
  en: {
    emailSubject: 'Card benefits to use',
    emailHeadingOne: 'You have 1 benefit to use',
    emailHeadingMany: 'You have {n} benefits to use',
    emailDone: 'Done',
    emailSnooze: 'Snooze {d}d',
    openDashboard: 'Open the full dashboard →',
    dashTitle: 'Card benefit tracker',
    dashSubtitle: 'Live status from your sheet. Reminders arrive by email automatically.',
    statTracked: 'benefits tracked',
    statToUse: 'still to use',
    statDone: 'done',
    badgeDone: 'Done',
    badgeToUse: 'To use',
    badgeSnoozed: 'Snoozed',
    snoozedUntil: 'Snoozed until {date}',
    expiryInfo: '{n}d left · expires {date}',
    expiryToday: 'expires today',
    markDone: 'Mark done',
    snooze: 'Snooze',
    undo: 'Undo',
    unsnooze: 'Un-snooze',
    removeCard: 'Remove card',
    confirmRemoveCard: 'Yes, remove all',
    confirmRemoveCardQ: 'Remove this card and all its benefits?',
    saving: 'Saving…',
    loading: 'Loading…',
    resets: 'resets',
    resetMonthly: 'monthly',
    resetQuarterly: 'quarterly',
    resetSemiannual: 'semi-annual',
    resetAnnual: 'annual',
    resetOnce: 'one-time',
    needSetup: 'Run setup() first in the Apps Script editor, then reload.',
    confirmDoneQ: 'Mark “{name}” as done?',
    confirmSnoozeQ: 'Snooze “{name}” for {d} days?',
    confirmYes: 'Confirm',
    confirmCancel: 'Cancel',
    doneOk: '✓ Marked “{name}” as done.',
    snoozeOk: 'Snoozed “{name}” for {d} days.',
    openDash: 'Open dashboard',
    invalidLink: 'Invalid or expired link.',
    notFound: 'Benefit not found.',
    snoozeTooLate: 'This benefit resets too soon to snooze — use it now.',
    accessDenied: 'Access denied — this tracker is private.',
    resetsOn: 'resets {date}',
    sortBy: 'Sort',
    sortExpiry: 'Expiry',
    sortAmount: 'Amount',
    sortName: 'Name',
    sortDefault: 'Default',
    snoozeNever: 'Skip this period',
    snoozePick: 'Pick a date',
    snoozePickDate: 'Snooze until…',
    addSelectAll: 'Select all',
    addClearAll: 'Clear all',
    // Add-cards wizard
    addCards: '+ Add cards',
    addTitle: 'Add cards',
    addSubtitle: 'Pick a card to see its known benefits, tick the ones you have, then add them.',
    addCardLabel: 'Card',
    addCardPlaceholder: 'Choose a card…',
    addCardOther: 'Other (type a name)',
    addCardNamePlaceholder: 'Card name',
    addVerified: 'Benefits as of {date}. Verify current terms with your issuer.',
    addColBenefit: 'Benefit',
    addColAmount: 'Amount',
    addColCategory: 'Category',
    addColReset: 'Resets',
    addBenefitNamePlaceholder: 'Benefit name',
    addAmountPlaceholder: 'e.g. $10',
    addAnotherBenefit: '+ Add another benefit',
    addSubmit: 'Add to my tracker',
    addPickCardFirst: 'Select a card to see its benefits.',
    addNeedCardName: 'Enter a card name first.',
    addNeedOne: 'Tick at least one benefit to add.',
    addNeedName: 'A ticked benefit has no name — fill it in or remove the row.',
    benefitUnitOne: 'benefit',
    benefitUnitMany: 'benefits',
    addedSummary: 'Added {added} {unit} to your {card} card; skipped {skipped} already tracked.',
    addedSummaryNoSkip: 'Added {added} {unit} to your {card} card.',
    addedNone: 'Nothing added — those benefits are already tracked.',
    addedToDash: '{card} is added to your dashboard.',
    deleteBenefit: 'Delete',
    addAnotherCard: 'Add another card',
    addOpenDash: 'Open dashboard →',
    editCard: 'Edit card',
    editSubtitle: '',
    editSubmit: 'Save changes',
    editSavedTitle: 'Saved',
    editLabelUpdated: 'Updated',
    editLabelAdded: 'Added',
    editLabelRemoved: 'Removed',
    editKeepEditing: 'Keep editing',
    menuLabel: 'More actions',
  },
  zh: {
    emailSubject: '待使用的信用卡权益',
    emailHeadingOne: '你有 1 项权益待使用',
    emailHeadingMany: '你有 {n} 项权益待使用',
    emailDone: '已使用',
    emailSnooze: '推迟{d}天',
    openDashboard: '打开完整面板 →',
    dashTitle: '信用卡权益追踪',
    dashSubtitle: '数据实时来自你的表格,提醒会自动发送到邮箱。',
    statTracked: '追踪权益',
    statToUse: '待使用',
    statDone: '已使用',
    badgeDone: '已使用',
    badgeToUse: '待使用',
    badgeSnoozed: '已推迟',
    snoozedUntil: '已推迟至 {date}',
    expiryInfo: '还剩 {n} 天 · {date} 到期',
    expiryToday: '今天到期',
    markDone: '标记已用',
    snooze: '推迟',
    undo: '撤销',
    unsnooze: '取消推迟',
    removeCard: '移除整张卡',
    confirmRemoveCard: '确认移除全部',
    confirmRemoveCardQ: '移除这张卡及其全部权益?',
    saving: '保存中…',
    loading: '加载中…',
    resets: '重置',
    resetMonthly: '每月',
    resetQuarterly: '每季',
    resetSemiannual: '每半年',
    resetAnnual: '每年',
    resetOnce: '一次性',
    needSetup: '请先在 Apps Script 编辑器运行 setup(),然后刷新。',
    confirmDoneQ: '确认把“{name}”标记为已使用?',
    confirmSnoozeQ: '确认把“{name}”推迟 {d} 天?',
    confirmYes: '确认',
    confirmCancel: '取消',
    doneOk: '✓ 已把“{name}”标记为已使用。',
    snoozeOk: '已把“{name}”推迟 {d} 天。',
    openDash: '打开面板',
    invalidLink: '链接无效或已过期。',
    notFound: '未找到该权益。',
    snoozeTooLate: '这项权益即将重置,来不及推迟了,请尽快使用。',
    accessDenied: '访问被拒绝 — 此追踪器为私有。',
    resetsOn: '{date} 刷新',
    sortBy: '排序',
    sortExpiry: '到期',
    sortAmount: '金额',
    sortName: '名称',
    sortDefault: '默认',
    snoozeNever: '本期跳过',
    snoozePick: '选个日期',
    snoozePickDate: '推迟到…',
    addSelectAll: '全选',
    addClearAll: '清除',
    // Add-cards wizard
    addCards: '+ 添加卡片',
    addTitle: '添加卡片',
    addSubtitle: '选择一张卡查看它的已知权益,勾选你拥有的,然后添加。',
    addCardLabel: '卡片',
    addCardPlaceholder: '选择一张卡…',
    addCardOther: '其他(手动输入)',
    addCardNamePlaceholder: '卡片名称',
    addVerified: '权益数据截至 {date}。请以发卡机构最新条款为准。',
    addColBenefit: '权益',
    addColAmount: '金额',
    addColCategory: '类别',
    addColReset: '重置',
    addBenefitNamePlaceholder: '权益名称',
    addAmountPlaceholder: '例如 $10',
    addAnotherBenefit: '+ 添加其他权益',
    addSubmit: '添加到我的追踪',
    addPickCardFirst: '请先选择一张卡查看其权益。',
    addNeedCardName: '请先填写卡片名称。',
    addNeedOne: '请至少勾选一项权益。',
    addNeedName: '有勾选的权益还没填名字 — 请填写或移除该行。',
    benefitUnitOne: '项',
    benefitUnitMany: '项',
    addedSummary: '已添加 {added} {unit}到「{card}」,跳过 {skipped} 项(已在追踪中)。',
    addedSummaryNoSkip: '已添加 {added} {unit}到「{card}」。',
    addedNone: '没有新增 — 这些权益都已在追踪中。',
    addedToDash: '已将「{card}」添加到你的面板。',
    deleteBenefit: '删除',
    addAnotherCard: '继续添加卡片',
    addOpenDash: '打开面板 →',
    editCard: '编辑卡片',
    editSubtitle: '',
    editSubmit: '保存修改',
    editSavedTitle: '已保存',
    editLabelUpdated: '更新',
    editLabelAdded: '新增',
    editLabelRemoved: '移除',
    editKeepEditing: '继续编辑',
    menuLabel: '更多操作',
  },
};

function t_(key) {
  const s = STRINGS[CONFIG.LANG] || STRINGS.en;
  return s[key] != null ? s[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
}
function fmt_(str, obj) {
  return String(str).replace(/\{(\w+)\}/g, function (m, k) {
    return (obj && obj[k] != null) ? obj[k] : m;
  });
}
function resetLabel_(reset) {
  if (reset === 'monthly') return t_('resetMonthly');
  if (reset === 'quarterly') return t_('resetQuarterly');
  if (reset === 'semiannual') return t_('resetSemiannual');
  if (reset === 'annual') return t_('resetAnnual');
  return t_('resetOnce');
}
// Localized labels for the category dropdown, keyed by the canonical CATEGORIES values.
function categoryLabelsMap_() {
  return CONFIG.LANG === 'zh'
    ? { travel: '旅行', dining: '餐饮', hotel: '酒店', streaming: '订阅', grocery: '生鲜', lounge: '休息室', other: '其他' }
    : { travel: 'Travel', dining: 'Dining', hotel: 'Hotel', streaming: 'Streaming', grocery: 'Grocery', lounge: 'Lounge', other: 'Other' };
}
function fmtShortDate_(date) {
  const tz = Session.getScriptTimeZone();
  return CONFIG.LANG === 'zh'
    ? Utilities.formatDate(date, tz, 'M月d日')
    : Utilities.formatDate(date, tz, 'MMM d');
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function jsonForHtml_(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');  // safe to inject in <script>
}

// ----------------------------- SETUP -----------------------------
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    seedExamples_(sheet);
    // LastDonePeriod stores text keys like "2026-06"; keep the column plain-text so Sheets
    // doesn't coerce them into dates.
    sheet.getRange(2, COL.LAST_DONE_PERIOD, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    sheet.autoResizeColumns(1, HEADERS.length);
  }
  setupCatalog();
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('sendReminders')
    .timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
  Logger.log('Setup complete. Now deploy as a Web App (execute as me, access "Only myself").');
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

// Create + seed the editable Catalog sheet from the CATALOG constant if it doesn't exist yet.
// Idempotent: leaves an existing sheet (which the user may have edited) untouched.
function setupCatalog() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(CONFIG.CATALOG_SHEET)) return;
  const sheet = ss.insertSheet(CONFIG.CATALOG_SHEET);
  const rows = [CATALOG_HEADERS];
  Object.keys(CATALOG).forEach(function (card) {
    const entry = CATALOG[card];
    entry.benefits.forEach(function (b) {
      rows.push([card, entry.lastVerified, b.benefit, b.amount, b.category, b.reset, b.reminderDays]);
    });
  });
  sheet.getRange(1, 1, rows.length, CATALOG_HEADERS.length).setValues(rows);
  sheet.getRange(1, 1, 1, CATALOG_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, CATALOG_HEADERS.length);
}

// ----------------------------- TIME / PERIOD -----------------------------
function periodKey_(reset, date) {
  const tz = Session.getScriptTimeZone();
  const yyyy = Utilities.formatDate(date, tz, 'yyyy');
  const m = Number(Utilities.formatDate(date, tz, 'MM'));  // 1-12
  if (reset === 'monthly')    return Utilities.formatDate(date, tz, 'yyyy-MM');
  if (reset === 'quarterly')  return yyyy + '-Q' + Math.ceil(m / 3);       // calendar quarter
  if (reset === 'semiannual') return yyyy + '-H' + (m <= 6 ? 1 : 2);       // H1 Jan-Jun, H2 Jul-Dec
  if (reset === 'annual')     return yyyy;
  return 'ONCE';
}
// Calendar-day number in the script timezone (DST-safe), not raw UTC ms.
function dayNumber_(date) {
  const s = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd').split('-');
  return Math.floor(Date.UTC(Number(s[0]), Number(s[1]) - 1, Number(s[2])) / 86400000);
}
function daysBetween_(a, b) { return dayNumber_(b) - dayNumber_(a); }

// Day number of the last day of a given 1-based month.
function lastDayOfMonthDayNumber_(y, monthOneBased) {
  const ny = (monthOneBased === 12) ? y + 1 : y;
  const nm = (monthOneBased === 12) ? 1 : monthOneBased + 1;
  return Math.floor(Date.UTC(ny, nm - 1, 1) / 86400000) - 1;  // day before the 1st of next month
}
// Last usable day of the current period (the benefit's effective expiry), as a day number.
function periodEndDayNumber_(reset, now) {
  const tz = Session.getScriptTimeZone();
  const y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const m = Number(Utilities.formatDate(now, tz, 'MM'));  // 1-12
  if (reset === 'monthly')    return lastDayOfMonthDayNumber_(y, m);
  if (reset === 'quarterly')  return lastDayOfMonthDayNumber_(y, Math.ceil(m / 3) * 3);
  if (reset === 'semiannual') return lastDayOfMonthDayNumber_(y, m <= 6 ? 6 : 12);
  if (reset === 'annual')     return lastDayOfMonthDayNumber_(y, 12);
  return null;  // 'once' / no expiry
}
// Day number of the first day of a given 1-based month.
function firstDayOfMonthDayNumber_(y, monthOneBased) {
  return Math.floor(Date.UTC(y, monthOneBased - 1, 1) / 86400000);
}
// First day of the current period, as a day number. 'once' has no period boundary → epoch (0),
// so an undated benefit still gets its single start nudge on the first scan, then never again.
function periodStartDayNumber_(reset, now) {
  const tz = Session.getScriptTimeZone();
  const y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const m = Number(Utilities.formatDate(now, tz, 'MM'));  // 1-12
  if (reset === 'monthly')    return firstDayOfMonthDayNumber_(y, m);
  if (reset === 'quarterly')  return firstDayOfMonthDayNumber_(y, (Math.ceil(m / 3) - 1) * 3 + 1);
  if (reset === 'semiannual') return firstDayOfMonthDayNumber_(y, m <= 6 ? 1 : 7);
  if (reset === 'annual')     return firstDayOfMonthDayNumber_(y, 1);
  return 0;  // 'once'
}
// Days before period end that the "use it soon" nudge fires; scales with period length.
function reminderLeadDays_(reset) {
  if (reset === 'monthly')   return 5;
  if (reset === 'quarterly') return 10;
  return 30;  // semiannual / annual (unused for 'once' — no expiry window)
}
// The benefit's expiry as a Date (noon-anchored so script-timezone formatting + day math never
// slip a day). null for 'once' (no expiry).
function periodEndDate_(reset, now) {
  const end = periodEndDayNumber_(reset, now);
  return end === null ? null : new Date(end * 86400000 + 12 * 3600000);
}
// First day of the NEXT period — when a used credit refreshes. Noon-anchored Date; null for 'once'.
function periodRefreshDate_(reset, now) {
  const end = periodEndDayNumber_(reset, now);
  return end === null ? null : new Date((end + 1) * 86400000 + 12 * 3600000);
}
// Calendar date ('yyyy-MM-dd') ↔ day number, on the same basis as dayNumber_ (so picker dates and
// period-end day numbers compare directly). The day number is a UTC-midnight count; format it back
// in UTC to recover the same calendar Y-M-D.
function ymdFromDayNumber_(n) {
  return Utilities.formatDate(new Date(n * 86400000), 'UTC', 'yyyy-MM-dd');
}
function parseDayNumber_(s) {
  const m = String(s == null ? '' : s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : null;
}
// Max days we may snooze without the return landing past the expiry. null = no cap.
function maxSnoozeDays_(reset, now) {
  const end = periodEndDayNumber_(reset, now);
  return (end === null) ? null : end - dayNumber_(now);
}
function snoozeOptionsFor_(reset, now) {
  const maxD = maxSnoozeDays_(reset, now);
  return SNOOZE_PRESETS.filter(function (d) { return maxD === null || d <= maxD; });
}
// Pure: the day number a snooze should land on, clamped to the current period so it never overshoots
// expiry. Returns null when the benefit can't be snoozed (expires today/already, or a bad date).
//   action 'snooze'     → `arg` is a day count
//   action 'snoozeEnd'  → through period end ("Never"); no-expiry ('once') → effectively forever
//   action 'snoozeDate' → `arg` is a 'yyyy-MM-dd' target, clamped to [tomorrow, period end]
function snoozeUntilDayNumber_(action, reset, now, arg) {
  const todayNum = dayNumber_(now);
  const endNum = periodEndDayNumber_(reset, now);   // null = no expiry ('once')
  if (endNum !== null && endNum <= todayNum) return null;
  if (action === 'snoozeEnd') return (endNum === null) ? todayNum + 36500 : endNum;
  if (action === 'snoozeDate') {
    const target = parseDayNumber_(arg);
    if (target === null) return null;
    let until = Math.max(todayNum + 1, target);
    if (endNum !== null) until = Math.min(until, endNum);
    return until;
  }
  let d = Number(arg) || CONFIG.SNOOZE_DEFAULT_DAYS;   // 'snooze' day count
  if (endNum !== null) d = Math.min(d, endNum - todayNum);
  return todayNum + Math.max(1, d);
}

// ----------------------------- DATA -----------------------------
// Forgiving parse of the Reset column → monthly/quarterly/semiannual/annual/once.
function normalizeReset_(v) {
  const r = String(v == null ? '' : v).toLowerCase().trim().replace(/[\s_\-]/g, '');
  if (r === '' || r === 'month' || r === 'monthly') return 'monthly';
  if (r === 'quarter' || r === 'quarterly') return 'quarterly';
  if (r === 'semiannual' || r === 'semiannually' || r === 'biannual' || r === 'halfyearly') return 'semiannual';
  if (r === 'annual' || r === 'annually' || r === 'yearly' || r === 'year') return 'annual';
  if (r === 'once' || r === 'onetime' || r === 'onceonly') return 'once';
  return r;  // unknown → treated as one-time downstream (periodKey_ → ONCE)
}
function readRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return { sheet: null, rows: [], missing: true };
  const last = sheet.getLastRow();
  if (last < 2) return { sheet: sheet, rows: [], missing: false };
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const rows = values.map(function (v, i) {
    return {
      rowIndex: i + 2,
      id: String(v[COL.ID - 1]),
      card: v[COL.CARD - 1],
      benefit: v[COL.BENEFIT - 1],
      amount: v[COL.AMOUNT - 1],
      category: v[COL.CATEGORY - 1],
      reset: normalizeReset_(v[COL.RESET - 1]),
      reminderDays: Number(v[COL.REMINDER_DAYS - 1]) || CONFIG.DEFAULT_REMINDER_DAYS,
      lastDonePeriod: String(v[COL.LAST_DONE_PERIOD - 1] || ''),
      lastReminded: v[COL.LAST_REMINDED - 1] ? new Date(v[COL.LAST_REMINDED - 1]) : null,
      snoozeUntil: v[COL.SNOOZE_UNTIL - 1] ? new Date(v[COL.SNOOZE_UNTIL - 1]) : null,
    };
  });
  return { sheet: sheet, rows: rows, missing: false };
}
function isDone_(row, now) { return row.lastDonePeriod === periodKey_(row.reset, now); }
function isSnoozed_(row, now) { return !!(row.snoozeUntil && now < row.snoozeUntil); }

// ----------------------------- CATALOG (read) -----------------------------
function validCategory_(c) {
  const v = String(c == null ? '' : c).toLowerCase().trim();
  return CATEGORIES.indexOf(v) !== -1 ? v : 'other';
}

// The catalog as the wizard consumes it: { cards: [{ card, lastVerified, benefits:[...] }] }.
// Prefers the editable Catalog sheet (so user edits win); falls back to the CATALOG constant.
// Not auth-gated itself — callers (getCatalog / addCardsPage_) sit behind requireAuth_ / doGet.
function getCatalogData_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CATALOG_SHEET);
  if (sheet && sheet.getLastRow() >= 2) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, CATALOG_HEADERS.length).getValues();
    const byCard = {};
    const order = [];
    values.forEach(function (v) {
      const card = String(v[0] || '').trim();
      const benefit = String(v[2] || '').trim();
      if (!card || !benefit) return;  // skip blank/partial rows
      if (!byCard[card]) { byCard[card] = { card: card, lastVerified: String(v[1] || ''), benefits: [] }; order.push(card); }
      byCard[card].benefits.push({
        benefit: benefit,
        amount: String(v[3] || ''),
        category: validCategory_(v[4]),
        reset: normalizeReset_(v[5]),
        reminderDays: Number(v[6]) || CONFIG.DEFAULT_REMINDER_DAYS,
      });
    });
    return { cards: order.map(function (k) { return byCard[k]; }) };
  }
  // Fallback: the shipped constant.
  return {
    cards: Object.keys(CATALOG).map(function (card) {
      return {
        card: card,
        lastVerified: CATALOG[card].lastVerified,
        benefits: CATALOG[card].benefits.map(function (b) {
          return { benefit: b.benefit, amount: b.amount, category: validCategory_(b.category),
                   reset: normalizeReset_(b.reset), reminderDays: Number(b.reminderDays) || CONFIG.DEFAULT_REMINDER_DAYS };
        }),
      };
    }),
  };
}

// Current Benefits rows for one card (for the wizard's edit mode), each with its ID so updateCard()
// can update in place and preserve done/snooze state.
function getCardRows_(card) {
  const key = String(card == null ? '' : card).toLowerCase().trim();
  const data = readRows_();
  const rows = data.missing ? [] : data.rows.filter(function (r) {
    return String(r.card).toLowerCase().trim() === key;
  });
  const have = {};
  rows.forEach(function (r) { have[String(r.benefit).toLowerCase().trim()] = true; });
  // Catalog benefits for this card that aren't on it yet — offered (unchecked) in edit mode.
  const cat = getCatalogData_().cards.filter(function (c) { return c.card.toLowerCase().trim() === key; })[0];
  const catNames = {};  // benefit names the catalog knows for this card → distinguishes user-added rows
  (cat ? cat.benefits : []).forEach(function (b) { catNames[String(b.benefit).toLowerCase().trim()] = true; });
  const suggestions = (cat ? cat.benefits : []).filter(function (b) {
    return !have[String(b.benefit).toLowerCase().trim()];
  }).map(function (b) {
    return { benefit: b.benefit, amount: b.amount, category: b.category, reset: b.reset, reminderDays: b.reminderDays };
  });
  return {
    card: rows.length ? rows[0].card : card,
    benefits: rows.map(function (r) {
      return { id: r.id, benefit: r.benefit, amount: r.amount, category: validCategory_(r.category),
               reset: r.reset, reminderDays: r.reminderDays,
               custom: !catNames[String(r.benefit).toLowerCase().trim()] };  // true = user-added (not in catalog)
    }),
    suggestions: suggestions,
  };
}

// ----------------------------- REMINDERS -----------------------------
// Period-driven: nudge once when a new period starts ("you have a fresh credit"), and once more as
// it nears expiry ("use it before it resets"). LastReminded (a date) is the only stored state — we
// compare its day number against each trigger day, so each nudge fires at most once per period and
// the cadence follows the reset frequency itself (no per-benefit ReminderDays needed).
function shouldRemind_(row, now) {
  const today = dayNumber_(now);
  const lr = row.lastReminded ? dayNumber_(row.lastReminded) : -Infinity;
  const start = periodStartDayNumber_(row.reset, now);
  if (today >= start && lr < start) return true;                 // start-of-period nudge
  const end = periodEndDayNumber_(row.reset, now);
  if (end !== null) {
    const windowStart = end - reminderLeadDays_(row.reset) + 1;
    if (today >= windowStart && lr < windowStart) return true;   // near-expiry nudge
  }
  return false;
}

function sendReminders() {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return; }
  try {
    const now = new Date();
    const data = readRows_();
    if (data.missing || data.rows.length === 0) return;

    const due = data.rows.filter(function (row) {
      if (isDone_(row, now)) return false;
      if (isSnoozed_(row, now)) return false;
      return shouldRemind_(row, now);
    });
    if (due.length === 0) return;

    MailApp.sendEmail({
      to: CONFIG.EMAIL,
      subject: t_('emailSubject') + ' (' +
        Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d') + ')',
      htmlBody: reminderHtml_(due),
    });

    // Batched single-range write of LastReminded (rows are scattered, so rewrite the column once).
    const n = data.rows.length;
    const colVals = data.sheet.getRange(2, COL.LAST_REMINDED, n, 1).getValues();
    due.forEach(function (row) { colVals[row.rowIndex - 2][0] = now; });
    data.sheet.getRange(2, COL.LAST_REMINDED, n, 1).setValues(colVals);
  } finally {
    lock.releaseLock();
  }
}

function reminderHtml_(due) {
  const url = ScriptApp.getService().getUrl();
  const heading = due.length === 1
    ? t_('emailHeadingOne')
    : fmt_(t_('emailHeadingMany'), { n: due.length });

  let html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px">';
  html += '<h2 style="font-weight:500;color:#1a1a18">' + esc_(heading) + '</h2>';
  html += '<table style="width:100%;border-collapse:collapse">';
  due.forEach(function (row) {
    const doneUrl = actionUrl_(url, 'done', row.id, '');
    const snoozeUrl = actionUrl_(url, 'snooze', row.id, '&days=' + CONFIG.SNOOZE_DEFAULT_DAYS);
    html +=
      '<tr style="border-bottom:1px solid #e6e4dc">' +
        '<td style="padding:12px 8px 12px 0;vertical-align:top">' +
          '<div style="font-size:15px;color:#1a1a18">' + esc_(row.benefit) + ' — ' + esc_(row.amount) + '</div>' +
          '<div style="font-size:13px;color:#6b6a64">' + esc_(row.card) + ' · ' +
            esc_(t_('resets')) + ' ' + esc_(resetLabel_(row.reset)) + '</div>' +
        '</td>' +
        '<td style="padding:12px 0;text-align:right;white-space:nowrap;vertical-align:top">' +
          '<a href="' + doneUrl + '" style="display:inline-block;padding:7px 14px;background:#0F6E56;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">' +
            esc_(t_('emailDone')) + '</a>&nbsp;' +
          '<a href="' + snoozeUrl + '" style="display:inline-block;padding:7px 14px;background:#f1efe8;color:#444441;border-radius:6px;text-decoration:none;font-size:13px">' +
            esc_(fmt_(t_('emailSnooze'), { d: CONFIG.SNOOZE_DEFAULT_DAYS })) + '</a>' +
        '</td>' +
      '</tr>';
  });
  html += '</table>';
  html += '<p style="margin-top:20px"><a href="' + url + '" style="color:#185FA5">' +
    esc_(t_('openDashboard')) + '</a></p></div>';
  return html;
}

function actionUrl_(url, action, id, extra) {
  let u = url + '?action=' + action + '&id=' + encodeURIComponent(id) + (extra || '');
  if (CONFIG.TOKEN) u += '&token=' + encodeURIComponent(CONFIG.TOKEN);
  return u;
}

// ----------------------------- WEB APP -----------------------------
function doGet(e) {
  if (!isAuthorized_()) return htmlMessage_(t_('accessDenied'));
  const params = (e && e.parameter) || {};
  const action = params.action;

  if (action === 'done' || action === 'snooze') {
    if (CONFIG.TOKEN && params.token !== CONFIG.TOKEN) return htmlMessage_(t_('invalidLink'));
    return confirmPage_(action, params);   // renders a confirm page; writes nothing
  }
  if (params.view === 'add') return addCardsPage_(params);
  return dashboardPage_();
}

// Empty allowlist => owner-only (Google's "Only myself" access is the guard). A populated
// allowlist only does anything if you also set access to "Anyone with a Google account".
function isAuthorized_() {
  const allow = CONFIG.AUTHORIZED_EMAILS || [];
  if (allow.length === 0) return true;
  const owner = Session.getEffectiveUser().getEmail();
  const user = Session.getActiveUser().getEmail();
  if (user && user === owner) return true;
  return !!(user && allow.indexOf(user) !== -1);
}
function requireAuth_() { if (!isAuthorized_()) throw new Error(t_('accessDenied')); }

function dashboardPage_() {
  const data = readRows_();
  const tpl = HtmlService.createTemplateFromFile('Index');
  tpl.missing = data.missing ? '1' : '';
  tpl.dataJson = jsonForHtml_(data.missing ? { cards: [] } : buildDashboardData_());
  tpl.uiJson = jsonForHtml_(uiStrings_());
  tpl.addUrl = ScriptApp.getService().getUrl() + '?view=add';
  return tpl.evaluate()
    .setTitle(t_('dashTitle'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function addCardsPage_(params) {
  const tpl = HtmlService.createTemplateFromFile('AddCards');
  tpl.catalogJson = jsonForHtml_(getCatalogData_());
  tpl.uiJson = jsonForHtml_(addUiStrings_());
  tpl.dashUrl = ScriptApp.getService().getUrl();
  const editCard = (params && params.edit) ? String(params.edit) : '';
  tpl.editJson = jsonForHtml_(editCard ? getCardRows_(editCard) : null);
  return tpl.evaluate()
    .setTitle(editCard ? t_('editCard') : t_('addTitle'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function confirmPage_(action, params) {
  const data = readRows_();
  if (data.missing) return htmlMessage_(t_('needSetup'));
  const row = data.rows.filter(function (r) { return r.id === String(params.id); })[0];
  if (!row) return htmlMessage_(t_('notFound'));
  let days = Number(params.days) || CONFIG.SNOOZE_DEFAULT_DAYS;
  if (action === 'snooze') {
    const maxD = maxSnoozeDays_(row.reset, new Date());  // show the capped value in the question
    if (maxD !== null && maxD >= 1) days = Math.min(days, maxD);
  }
  const question = action === 'done'
    ? fmt_(t_('confirmDoneQ'), { name: row.benefit })
    : fmt_(t_('confirmSnoozeQ'), { name: row.benefit, d: days });

  const tpl = HtmlService.createTemplateFromFile('Confirm');
  tpl.question = question;
  tpl.dashUrl = ScriptApp.getService().getUrl();
  tpl.ctxJson = jsonForHtml_({
    action: action, id: row.id, days: days, token: CONFIG.TOKEN || '',
    confirmLabel: t_('confirmYes'), cancelLabel: t_('confirmCancel'), openDash: t_('openDash'),
  });
  return tpl.evaluate()
    .setTitle(t_('dashTitle'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// --- Server functions callable from the dashboard via google.script.run ---
function markDone(id) { requireAuth_(); applyAction_('done', id);     return buildDashboardData_(); }
function snooze(id, days) { requireAuth_(); applyAction_('snooze', id, days); return buildDashboardData_(); }
function undo(id)     { requireAuth_(); applyAction_('undo', id);     return buildDashboardData_(); }
function unsnooze(id) { requireAuth_(); applyAction_('unsnooze', id); return buildDashboardData_(); }
function snoozeEnd(id) { requireAuth_(); applyAction_('snoozeEnd', id); return buildDashboardData_(); }      // "Never" — through period end
function snoozeDate(id, dateStr) { requireAuth_(); applyAction_('snoozeDate', id, dateStr); return buildDashboardData_(); }  // explicit date, server-clamped

// --- Dashboard remove card (google.script.run) — deletes all of a card's rows. Irreversible (the
// menu confirms first); a deleted card can be re-added via the wizard. Auth + lock. Per-benefit
// removal now lives in the wizard's edit mode (updateCard), so there's no removeBenefit here. ---
function removeCard(card) {
  requireAuth_();
  const key = String(card == null ? '' : card).toLowerCase().trim();
  removeRows_(function (r) { return String(r.card).toLowerCase().trim() === key; });
  return buildDashboardData_();
}
function removeRows_(match) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const data = readRows_();
    if (data.missing) throw new Error(t_('needSetup'));
    const targets = data.rows.filter(match).map(function (r) { return r.rowIndex; });
    targets.sort(function (a, b) { return b - a; });  // delete bottom-up so row indexes don't shift
    targets.forEach(function (idx) { data.sheet.deleteRow(idx); });
    return targets.length;
  } finally {
    lock.releaseLock();
  }
}

// --- Add-cards wizard server functions (google.script.run) ---
function getCatalog() { requireAuth_(); return getCatalogData_(); }

// Append the wizard's selected benefits to the Benefits sheet. Auth + lock + per-item validation
// (category coerced into CATEGORIES, reset via normalizeReset_) + dedup (same card + benefit name,
// case-insensitive, against existing rows AND within the batch) + unique slug ID + one batched
// write. Returns { added, skipped }. Mirrors applyAction_: LastDonePeriod stays plain-text.
function addBenefits(card, items) {
  requireAuth_();
  const cardName = String(card == null ? '' : card).trim();
  if (!cardName) throw new Error(t_('addNeedCardName'));
  if (!items || !items.length) throw new Error(t_('addNeedOne'));

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const data = readRows_();
    if (data.missing) throw new Error(t_('needSetup'));
    const sheet = data.sheet;

    const seenKey = {};   // case-insensitive card+benefit → skip duplicates
    const usedId = {};    // existing + freshly minted IDs → guarantee uniqueness
    data.rows.forEach(function (r) {
      seenKey[dedupKey_(r.card, r.benefit)] = true;
      usedId[String(r.id)] = true;
    });

    const newRows = [];
    let skipped = 0;
    items.forEach(function (it) {
      const benefit = String(it && it.benefit != null ? it.benefit : '').trim();
      if (!benefit) return;  // nameless rows are silently ignored
      const key = dedupKey_(cardName, benefit);
      if (seenKey[key]) { skipped++; return; }
      seenKey[key] = true;

      const id = uniqueId_(cardName, benefit, usedId);
      usedId[id] = true;
      let rd = Math.round(Number(it && it.reminderDays));
      if (!(rd >= 1)) rd = CONFIG.DEFAULT_REMINDER_DAYS;
      newRows.push([
        id, cardName, benefit,
        String(it && it.amount != null ? it.amount : '').trim(),
        validCategory_(it && it.category),
        normalizeReset_(it && it.reset),
        rd, '', '', '',
      ]);
    });

    if (newRows.length) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, HEADERS.length).setValues(newRows);
      // Force LastDonePeriod plain-text on the appended rows, or Sheets coerces keys like
      // "2026-06" into Dates and they never match periodKey_() (the benefit looks un-done).
      sheet.getRange(startRow, COL.LAST_DONE_PERIOD, newRows.length, 1).setNumberFormat('@');
    }
    return { added: newRows.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function dedupKey_(card, benefit) {
  return String(card).toLowerCase().trim() + ' ' + String(benefit).toLowerCase().trim();
}
function slugify_(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function uniqueId_(card, benefit, usedId) {
  const base = (slugify_(card) + '_' + slugify_(benefit)).replace(/^_+|_+$/g, '') || 'benefit';
  let id = base, n = 2;
  while (usedId[id]) { id = base + '-' + n; n++; }
  return id;
}

// Edit-mode save (google.script.run). Apply the wizard's edited rows to one card: items with an
// existing id are updated in place (status columns LastDonePeriod/LastReminded/SnoozeUntil are left
// untouched, so done/snooze progress survives); this card's existing rows that weren't resubmitted
// are deleted; items without an id are appended. Auth + lock. Returns { updated, added, removed }.
function updateCard(card, items) {
  requireAuth_();
  const cardName = String(card == null ? '' : card).trim();
  if (!cardName) throw new Error(t_('addNeedCardName'));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const data = readRows_();
    if (data.missing) throw new Error(t_('needSetup'));
    const sheet = data.sheet;
    const key = cardName.toLowerCase();

    const existing = {};   // id → row, this card only
    const usedId = {};     // every id in the sheet (for new-id collisions)
    data.rows.forEach(function (r) {
      usedId[String(r.id)] = true;
      if (String(r.card).toLowerCase().trim() === key) existing[String(r.id)] = r;
    });

    const updates = [], newRows = [], keep = {}, seen = {};
    (items || []).forEach(function (it) {
      const benefit = String(it && it.benefit != null ? it.benefit : '').trim();
      if (!benefit) return;
      let rd = Math.round(Number(it && it.reminderDays));
      if (!(rd >= 1)) rd = CONFIG.DEFAULT_REMINDER_DAYS;
      const vals = [benefit, String(it && it.amount != null ? it.amount : '').trim(),
                    validCategory_(it && it.category), normalizeReset_(it && it.reset)];
      const id = it && it.id ? String(it.id) : '';
      if (id && existing[id]) {
        const cur = existing[id];
        keep[id] = true;  // resubmitted → keep the row even when nothing changed
        // Only treat it as an update (write + report) if a field actually differs from the stored
        // row. The wizard resubmits every prefilled row unchanged, so without this diff the
        // "Updated:" summary would list untouched benefits and inflate the count. Compare against
        // the same normalization the new vals went through (category/reset/trim).
        const changed =
          vals[0] !== String(cur.benefit == null ? '' : cur.benefit).trim() ||
          vals[1] !== String(cur.amount == null ? '' : cur.amount).trim() ||
          vals[2] !== validCategory_(cur.category) ||
          vals[3] !== normalizeReset_(cur.reset) ||
          rd !== cur.reminderDays;
        if (changed) updates.push({ rowIndex: cur.rowIndex, vals: vals, rd: rd });
      } else {
        const k = key + ' ' + benefit.toLowerCase();
        if (seen[k]) return;
        seen[k] = true;
        const newId = uniqueId_(cardName, benefit, usedId);
        usedId[newId] = true;
        newRows.push([newId, cardName, vals[0], vals[1], vals[2], vals[3], rd, '', '', '']);
      }
    });

    const removeIdx = [], removedNames = [];
    Object.keys(existing).forEach(function (id) {
      if (!keep[id]) { removeIdx.push(existing[id].rowIndex); removedNames.push(existing[id].benefit); }
    });

    // Order matters: updates + appends use pre-delete row indexes, so delete last (bottom-up).
    updates.forEach(function (u) {
      sheet.getRange(u.rowIndex, COL.BENEFIT, 1, 4).setValues([u.vals]);  // Benefit, Amount, Category, Reset
      sheet.getRange(u.rowIndex, COL.REMINDER_DAYS).setValue(u.rd);
    });
    if (newRows.length) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, newRows.length, HEADERS.length).setValues(newRows);
      sheet.getRange(startRow, COL.LAST_DONE_PERIOD, newRows.length, 1).setNumberFormat('@');
    }
    removeIdx.sort(function (a, b) { return b - a; });
    removeIdx.forEach(function (idx) { sheet.deleteRow(idx); });

    // Return the benefit names changed + the card's refreshed state (for "keep editing").
    return {
      updated: updates.map(function (u) { return u.vals[0]; }),
      added: newRows.map(function (r) { return r[2]; }),
      removed: removedNames,
      card: getCardRows_(cardName),
    };
  } finally {
    lock.releaseLock();
  }
}

// --- Server function callable from the confirmation page via google.script.run ---
function confirmFromEmail(action, id, days, token) {
  requireAuth_();
  if (CONFIG.TOKEN && token !== CONFIG.TOKEN) return { ok: false, message: t_('invalidLink') };
  const res = applyAction_(action, id, days);
  if (!res.ok) return { ok: false, message: t_(res.key === 'snoozeTooLate' ? 'snoozeTooLate' : 'notFound') };
  let message = '✓';
  if (res.key === 'doneOk') message = fmt_(t_('doneOk'), { name: res.name });
  else if (res.key === 'snoozeOk') message = fmt_(t_('snoozeOk'), { name: res.name, d: res.days });
  return { ok: true, message: message };
}

// The single source of truth for writes. Both the dashboard and the confirmation page reach
// state changes through here; the email-link GET never mutates on its own.
function applyAction_(action, id, days) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date();
    const data = readRows_();
    if (data.missing) throw new Error(t_('needSetup'));
    const row = data.rows.filter(function (r) { return r.id === String(id); })[0];
    if (!row) return { ok: false, key: 'notFound' };

    if (action === 'done') {
      // Force plain-text format first, or Sheets coerces a monthly key like "2026-06" into a
      // Date — which then never matches periodKey_() on read (the benefit looks un-done).
      data.sheet.getRange(row.rowIndex, COL.LAST_DONE_PERIOD)
        .setNumberFormat('@').setValue(periodKey_(row.reset, now));
      data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL).setValue('');
      return { ok: true, key: 'doneOk', name: row.benefit };
    }
    if (action === 'undo') {
      data.sheet.getRange(row.rowIndex, COL.LAST_DONE_PERIOD).setValue('');
      return { ok: true, key: 'undoOk', name: row.benefit };
    }
    if (action === 'unsnooze') {
      data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL).setValue('');
      return { ok: true, key: 'unsnoozeOk', name: row.benefit };
    }
    // snooze variants ('snooze' day-count · 'snoozeEnd' = "Never" · 'snoozeDate' = picked date),
    // all clamped so the return never lands past the benefit's expiry (see snoozeUntilDayNumber_).
    const untilNum = snoozeUntilDayNumber_(action, row.reset, now, days);
    if (untilNum === null) return { ok: false, key: 'snoozeTooLate', name: row.benefit };
    data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL)
      .setValue(new Date(untilNum * 86400000 + 12 * 3600000));     // noon-anchored, tz-safe
    return { ok: true, key: 'snoozeOk', name: row.benefit, days: untilNum - dayNumber_(now) };
  } finally {
    lock.releaseLock();
  }
}

function buildDashboardData_() {
  const now = new Date();
  const data = readRows_();
  const cards = {};
  const order = [];
  data.rows.forEach(function (row) {
    if (!cards[row.card]) { cards[row.card] = { card: row.card, benefits: [] }; order.push(row.card); }
    const done = isDone_(row, now);
    const snoozed = isSnoozed_(row, now);
    const endNum = periodEndDayNumber_(row.reset, now);            // null = no expiry ('once')
    const daysLeft = (endNum === null) ? null : endNum - dayNumber_(now);  // sort key; days to period end
    // For a still-to-use benefit, how long until it resets (days left + expiry date). Skipped for
    // done/snoozed rows (those show their own status) and 'once' (no expiry).
    let expiryInfo = '';
    if (!done && !snoozed && endNum !== null) {
      expiryInfo = daysLeft <= 0 ? t_('expiryToday')
        : fmt_(t_('expiryInfo'), { n: daysLeft, date: fmtShortDate_(periodEndDate_(row.reset, now)) });
    }
    // For a done benefit, when the credit refreshes (start of next period). Skipped for 'once'.
    let refreshInfo = '';
    if (done) {
      const refresh = periodRefreshDate_(row.reset, now);
      if (refresh) refreshInfo = fmt_(t_('resetsOn'), { date: fmtShortDate_(refresh) });
    }
    cards[row.card].benefits.push({
      id: row.id, benefit: row.benefit, amount: row.amount, category: row.category,
      reset: row.reset, done: done, snoozed: snoozed, daysLeft: daysLeft,
      snoozeInfo: snoozed ? fmt_(t_('snoozedUntil'), { date: fmtShortDate_(row.snoozeUntil) }) : '',
      expiryInfo: expiryInfo,
      refreshInfo: refreshInfo,
      snoozeOptions: (!done && !snoozed) ? snoozeOptionsFor_(row.reset, now) : [],
      snoozeMaxDate: (!done && !snoozed && endNum !== null) ? ymdFromDayNumber_(endNum) : '',  // date-picker cap
    });
  });
  return { cards: order.map(function (k) { return cards[k]; }) };
}

function uiStrings_() {
  return {
    title: t_('dashTitle'), subtitle: t_('dashSubtitle'), addCards: t_('addCards'),
    statTracked: t_('statTracked'), statToUse: t_('statToUse'), statDone: t_('statDone'),
    badgeDone: t_('badgeDone'), badgeToUse: t_('badgeToUse'), badgeSnoozed: t_('badgeSnoozed'),
    markDone: t_('markDone'), snooze: t_('snooze'), undo: t_('undo'), unsnooze: t_('unsnooze'),
    snoozeNever: t_('snoozeNever'), snoozePick: t_('snoozePick'), snoozePickDate: t_('snoozePickDate'),
    sortBy: t_('sortBy'),
    sortLabels: { expiry: t_('sortExpiry'), amount: t_('sortAmount'), name: t_('sortName'), default: t_('sortDefault') },
    removeCard: t_('removeCard'), editCard: t_('editCard'), menuLabel: t_('menuLabel'),
    confirmRemoveCard: t_('confirmRemoveCard'), confirmRemoveCardQ: t_('confirmRemoveCardQ'),
    confirm: t_('confirmYes'), cancel: t_('confirmCancel'),
    dayUnit: (CONFIG.LANG === 'zh' ? '天' : 'd'),
    saving: t_('saving'), loading: t_('loading'), resets: t_('resets'),
    resetLabels: { monthly: t_('resetMonthly'), quarterly: t_('resetQuarterly'),
      semiannual: t_('resetSemiannual'), annual: t_('resetAnnual'), once: t_('resetOnce') },
    needSetup: t_('needSetup'),
  };
}

// Strings + option maps the Add-cards wizard (AddCards.html) renders entirely from.
function addUiStrings_() {
  return {
    title: t_('addTitle'), subtitle: t_('addSubtitle'),
    editTitle: t_('editCard'), editSubtitle: t_('editSubtitle'), editSubmit: t_('editSubmit'),
    savedTitle: t_('editSavedTitle'), labelUpdated: t_('editLabelUpdated'), labelAdded: t_('editLabelAdded'),
    labelRemoved: t_('editLabelRemoved'), keepEditing: t_('editKeepEditing'),
    cardLabel: t_('addCardLabel'), cardPlaceholder: t_('addCardPlaceholder'),
    cardOther: t_('addCardOther'), cardNamePlaceholder: t_('addCardNamePlaceholder'),
    verified: t_('addVerified'),
    colBenefit: t_('addColBenefit'), colAmount: t_('addColAmount'),
    colCategory: t_('addColCategory'), colReset: t_('addColReset'),
    benefitNamePlaceholder: t_('addBenefitNamePlaceholder'), amountPlaceholder: t_('addAmountPlaceholder'),
    addBenefit: t_('addAnotherBenefit'), submit: t_('addSubmit'), cancel: t_('confirmCancel'),
    selectAll: t_('addSelectAll'), clearAll: t_('addClearAll'),
    pickCardFirst: t_('addPickCardFirst'), needCardName: t_('addNeedCardName'), needOne: t_('addNeedOne'), needName: t_('addNeedName'),
    addedSummary: t_('addedSummary'), addedSummaryNoSkip: t_('addedSummaryNoSkip'), addedNone: t_('addedNone'),
    addedToDash: t_('addedToDash'), deleteBenefit: t_('deleteBenefit'),
    unitOne: t_('benefitUnitOne'), unitMany: t_('benefitUnitMany'),
    addAnotherCard: t_('addAnotherCard'), openDash: t_('addOpenDash'),
    saving: t_('saving'),
    categories: CATEGORIES, catLabels: categoryLabelsMap_(),
    resets: ['monthly', 'quarterly', 'semiannual', 'annual', 'once'],
    resetLabels: { monthly: t_('resetMonthly'), quarterly: t_('resetQuarterly'),
      semiannual: t_('resetSemiannual'), annual: t_('resetAnnual'), once: t_('resetOnce') },
  };
}

function htmlMessage_(msg) {
  const url = ScriptApp.getService().getUrl();
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;padding:40px;text-align:center;font-size:18px;color:#1a1a18;background:#faf9f5">' +
    esc_(msg) + '<br><br><a href="' + url + '" style="color:#185FA5;font-size:15px">' +
    esc_(t_('openDash')) + '</a></div>')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
