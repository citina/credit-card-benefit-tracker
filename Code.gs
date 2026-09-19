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
  // The deployed web-app /exec URL is NOT set here: it lives in the Script Property WEBAPP_URL
  // (Project Settings → Script properties), so it survives pasting new code and never gets
  // committed. See SETUP.md step 5 and webAppUrl_().
  DEFAULT_REMINDER_DAYS: 4,
  SNOOZE_DEFAULT_DAYS: 3,
  DAILY_HOUR: 9,                                  // 24h, script timezone
  // Reminder cadence (global): 'minimal' = one nudge at the start of a period + one near expiry;
  // 'persistent' = additionally re-nudge every REMINDER_REPEAT_DAYS within the near-expiry window
  // until the benefit is done/snoozed. Change this one value to switch how naggy reminders are.
  REMINDER_CADENCE: 'minimal',                    // 'minimal' | 'persistent'
  REMINDER_REPEAT_DAYS: 2,                         // persistent: days between re-nudges in the expiry window
  CATALOG_REVIEW_AFTER_MONTHS: 6,                 // flag catalog rows whose LastVerified is older than this
  CATALOG_REVIEW_HOUR: 10,                        // 24h, script timezone — monthly stale-catalog review email
  SHEET_NAME: 'Benefits',
  CATALOG_SHEET: 'Catalog',                       // editable benefit catalog the Add-cards wizard reads
  CARDS_SHEET: 'Cards',                           // per-card annual fee + open date (for the realized-value bar)
};

// ----------------------------- SCHEMA -----------------------------
const COL = {
  ID: 1, CARD: 2, BENEFIT: 3, AMOUNT: 4, CATEGORY: 5,
  RESET: 6, REMINDER_DAYS: 7, LAST_DONE_PERIOD: 8,
  LAST_REMINDED: 9, SNOOZE_UNTIL: 10,
  REALIZED_VALUE: 11, REALIZED_PERIOD: 12,
};
const HEADERS = ['ID', 'Card', 'Benefit', 'Amount', 'Category', 'Reset',
                 'ReminderDays', 'LastDonePeriod', 'LastReminded', 'SnoozeUntil',
                 'RealizedValue', 'RealizedPeriod'];
// Per-card sheet for the realized-value bar:
//   AnnualFee          — the fee the bar measures value against
//   Anniversary        — the card's renewal month/day 'MM-DD' (anchors the annual-fee period AND
//                        anniversary-basis benefit resets, #3). Plain-text. Year not needed.
//   RealizedSeed       — a manual "already used this membership year" $ catch-up (for people who
//                        start tracking mid-year); added to the bar, reset at the anniversary.
//   RealizedSeedPeriod — the annual-fee-period start year the seed belongs to (lazy reset key).
const CARDS_HEADERS = ['Card', 'AnnualFee', 'Anniversary', 'RealizedSeed', 'RealizedSeedPeriod'];
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
    lastVerified: '2026-06-19',
    annualFee: 95,
    benefits: [
      // Chase Travel hotel credit doubled to $100/anniversary year effective 2026-06-15.
      // ANNIVERSARY-year reset (cardmember year, NOT calendar) — verified 2026-06. periodBasis
      // 'anniversary' shifts its reset/expiry off Jan 1 to the card's anniversary (#3); needs the
      // card's Anniversary set, else it falls back to calendar.
      { benefit: 'Hotel credit (Chase Travel)', amount: '$100', category: 'hotel',  reset: 'annual',  reminderDays: 30, periodBasis: 'anniversary' },
      { benefit: 'DoorDash credit (DashPass)',  amount: '$10',  category: 'dining', reset: 'monthly', reminderDays: 7 },
    ],
  },
  'Amex Gold': {
    lastVerified: '2026-06-19',
    annualFee: 325,
    benefits: [
      { benefit: 'Uber Cash',     amount: '$10', category: 'other',  reset: 'monthly',    reminderDays: 4 },
      { benefit: 'Dining credit', amount: '$10', category: 'dining', reset: 'monthly',    reminderDays: 7 },  // Grubhub, Five Guys, Cheesecake Factory, etc.
      { benefit: 'Dunkin credit', amount: '$7',  category: 'dining', reset: 'monthly',    reminderDays: 7 },
      { benefit: 'Resy credit',   amount: '$50', category: 'dining', reset: 'semiannual', reminderDays: 21 }, // $50 H1 + $50 H2
    ],
  },
  'Amex Platinum': {
    lastVerified: '2026-06-19',
    annualFee: 695,
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
    lastVerified: '2026-06-19',
    annualFee: 795,
    benefits: [
      { benefit: 'Dining credit (Exclusive Tables)', amount: '$150', category: 'dining',  reset: 'semiannual', reminderDays: 21 }, // OpenTable; $150 H1 + $150 H2
      { benefit: 'The Edit hotel credit',            amount: '$250', category: 'hotel',   reset: 'semiannual', reminderDays: 30 },
      { benefit: 'StubHub / viagogo credit',         amount: '$150', category: 'other',   reset: 'semiannual', reminderDays: 21 },
      { benefit: 'DoorDash credit (DashPass)',       amount: '$25',  category: 'dining',  reset: 'monthly',    reminderDays: 7 },  // $5 restaurant + 2×$10 non-restaurant
      { benefit: 'Lyft credit',                      amount: '$10',  category: 'travel',  reset: 'monthly',    reminderDays: 7 },
      { benefit: 'Peloton credit',                   amount: '$120', category: 'other',   reset: 'annual',     reminderDays: 30 },
      // ANNIVERSARY-year reset (account anniversary, NOT calendar) — verified 2026-06. periodBasis
      // 'anniversary' shifts reset/expiry to the card anniversary (#3); needs Anniversary set.
      { benefit: 'Annual travel credit',             amount: '$300', category: 'travel',  reset: 'annual',     reminderDays: 30, periodBasis: 'anniversary' },
    ],
  },
  // Added 2026-06-19 — verify amounts/fees against the issuer before relying on them.
  'Capital One Venture X': {
    lastVerified: '2026-06-19',
    annualFee: 395,
    benefits: [
      // $300 travel credit via Capital One Travel; resets on the CARD ANNIVERSARY year (set the
      // card's anniversary, like CSP/CSR). The 10k anniversary miles aren't a $ credit (excluded).
      { benefit: 'Annual travel credit (Capital One Travel)', amount: '$300', category: 'travel', reset: 'annual', reminderDays: 30, periodBasis: 'anniversary' },
    ],
  },
  'Marriott Bonvoy Brilliant': {
    lastVerified: '2026-06-19',
    annualFee: 650,
    benefits: [
      { benefit: 'Dining credit', amount: '$25', category: 'dining', reset: 'monthly', reminderDays: 7 },  // $25/month
    ],
  },
  'Citi Strata Premier': {
    lastVerified: '2026-06-19',
    annualFee: 95,
    benefits: [
      { benefit: 'Annual hotel credit', amount: '$100', category: 'hotel', reset: 'annual', reminderDays: 30 },  // one hotel stay of $500+
    ],
  },
  'Amex Green': {
    lastVerified: '2026-06-19',
    annualFee: 150,
    benefits: [
      { benefit: 'CLEAR Plus credit', amount: '$209', category: 'travel', reset: 'annual', reminderDays: 30 },
    ],
  },
};
// Appended columns (SourceUrl/PeriodBasis/Notes) are migrated onto existing sheets by ensureHeaders_
// (PITFALLS #2 — append only, never reorder). getCatalogData_ reads by header NAME, so old 7-column
// sheets and new 10-column sheets both parse.
const CATALOG_HEADERS = ['Card', 'LastVerified', 'Benefit', 'Amount', 'Category', 'Reset', 'ReminderDays',
                         'SourceUrl', 'PeriodBasis', 'Notes'];

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
    catalogReviewSubject: 'Catalog review: {n} card(s) to re-verify',
    catalogReviewHeading: '{n} card(s) may have outdated benefits',
    catalogReviewIntro: 'These were last verified a while ago. Check the issuer terms, then update the Catalog sheet (LastVerified, amounts, etc.). Nothing is changed automatically.',
    catalogReviewVerified: 'Last verified {date} · {months} months ago',
    catalogReviewSource: 'Open source page',
    dashTitle: 'Card benefit tracker',
    emptyTitle: 'No cards yet',
    emptySub: 'Add your cards to start tracking benefits before they expire.',
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
    setAnniversary: 'Set anniversary for accurate timing',
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
    addClearAllConfirm: 'Clear all unchecks these {n} benefit(s); saving removes them from this card:',
    // Add-cards wizard
    addCards: '+ Add cards',
    addTitle: 'Add cards',
    addCardLabel: 'Card',
    addCardPlaceholder: 'Choose a card…',
    addCardOther: 'Other (type a name)',
    addCardNamePlaceholder: 'Card name',
    addVerified: 'Last verified: {date}. Terms may vary by issuer.',
    addSource: 'Source',
    addReviewRecommended: 'Review recommended',
    addDuplicateName: 'Two benefits have the same name: "{name}". Rename one to continue.',
    addColBenefit: 'Benefit',
    addColAmount: 'Amount',
    addColCategory: 'Category',
    addColReset: 'Resets',
    addBenefitNamePlaceholder: 'Benefit name',
    addAmountPlaceholder: 'e.g. $10',
    annualFeeLabel: 'Annual fee',
    anniversaryLabel: 'Card anniversary',
    annualFeePlaceholder: 'e.g. 95',
    realizedSeedLabel: 'Already used this year',
    realizedSeedHelp: 'Value used before tracking; in-app marks add on top. Resets at your anniversary.',
    addAnotherBenefit: '+ Add another benefit',
    addSubmit: 'Add to my tracker',
    addPickCardFirst: 'Select a card to see its benefits.',
    addNeedCardName: 'Enter a card name first.',
    addNeedOne: 'Tick at least one benefit to add.',
    addNeedName: 'A ticked benefit has no name — fill it in or remove the row.',
    addNeedAnniversary: 'Set the card anniversary (month + day) — this card has an annual fee.',
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
    catalogReviewSubject: 'Catalog 复核:{n} 张卡待重新核实',
    catalogReviewHeading: '{n} 张卡的权益可能已过期',
    catalogReviewIntro: '这些卡距上次核实已有一段时间。请对照发卡机构条款,然后手动更新 Catalog sheet(LastVerified、金额等)。系统不会自动改动任何数据。',
    catalogReviewVerified: '上次核实 {date} · {months} 个月前',
    catalogReviewSource: '打开来源页面',
    dashTitle: '信用卡权益追踪',
    emptyTitle: '还没有卡片',
    emptySub: '添加你的卡片,开始追踪权益,别让它们过期。',
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
    setAnniversary: '设置周年日以校准周期',
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
    addClearAllConfirm: 'Clear all 会取消勾选这 {n} 项权益,保存后会把它们从这张卡移除:',
    // Add-cards wizard
    addCards: '+ 添加卡片',
    addTitle: '添加卡片',
    addCardLabel: '卡片',
    addCardPlaceholder: '选择一张卡…',
    addCardOther: '其他(手动输入)',
    addCardNamePlaceholder: '卡片名称',
    addVerified: '上次核实:{date}。条款以发卡机构为准。',
    addSource: '来源',
    addReviewRecommended: '建议复核',
    addDuplicateName: '有两项权益同名:「{name}」。请改一个名字再继续。',
    addColBenefit: '权益',
    addColAmount: '金额',
    addColCategory: '类别',
    addColReset: '重置',
    addBenefitNamePlaceholder: '权益名称',
    addAmountPlaceholder: '例如 $10',
    annualFeeLabel: '年费',
    anniversaryLabel: '卡片周年日',
    annualFeePlaceholder: '例如 95',
    realizedSeedLabel: '本年度已实现',
    realizedSeedHelp: '进入追踪前已用掉的价值;之后在 app 里标记的会累加在上面,周年日自动清零。',
    addAnotherBenefit: '+ 添加其他权益',
    addSubmit: '添加到我的追踪',
    addPickCardFirst: '请先选择一张卡查看其权益。',
    addNeedCardName: '请先填写卡片名称。',
    addNeedOne: '请至少勾选一项权益。',
    addNeedName: '有勾选的权益还没填名字 — 请填写或移除该行。',
    addNeedAnniversary: '请先填写卡片周年日(月 + 日)—— 这张卡有年费。',
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
    sheet.autoResizeColumns(1, HEADERS.length);
  } else {
    // Migration for an already-seeded Benefits sheet: re-stamp the full header row so the two
    // realized-value columns (RealizedValue / RealizedPeriod) get labeled; existing data rows keep
    // their values and the new cells stay blank (read as 0 / stale). Re-running this is harmless.
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  }
  // LastDonePeriod + RealizedPeriod store text keys ("2026-06", "2026"); keep both columns
  // plain-text so Sheets doesn't coerce them into dates (idempotent, safe on every run).
  sheet.getRange(2, COL.LAST_DONE_PERIOD, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  sheet.getRange(2, COL.REALIZED_PERIOD, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  setupCards();
  setupCatalog();
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    const fn = tr.getHandlerFunction();
    if (fn === 'sendReminders' || fn === 'reviewStaleCatalog') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('sendReminders')
    .timeBased().everyDays(1).atHour(CONFIG.DAILY_HOUR).create();
  ScriptApp.newTrigger('reviewStaleCatalog')             // monthly: nudge to re-verify stale catalog rows
    .timeBased().onMonthDay(1).atHour(CONFIG.CATALOG_REVIEW_HOUR).create();
  Logger.log('Setup complete. Now deploy as a Web App (execute as me, access "Only myself").');
  if (!pinnedWebAppUrl_()) Logger.log('Then set the Script Property WEBAPP_URL to the /exec URL (SETUP.md step 5).');
}

function seedExamples_(sheet) {
  const rows = [
    ['amex_dining', 'Amex Gold', 'Dining credit', '$10', 'dining', 'monthly', 4, '', '', '', '', ''],
    ['amex_uber',   'Amex Gold', 'Uber Cash',     '$10', 'other',  'monthly', 4, '', '', '', '', ''],
    ['csr_travel',  'Chase Sapphire Reserve', 'Annual travel credit', '$300', 'travel', 'annual', 14, '', '', '', '', ''],
    ['csr_lounge',  'Chase Sapphire Reserve', 'Priority Pass lounge', 'Unlimited', 'lounge', 'annual', 30, '', '', '', '', ''],
  ];
  rows.forEach(function (r) { sheet.appendRow(r); });
}

// Append any of `headers` missing from an existing sheet's header row to the right, preserving every
// existing column and value (PITFALLS #2 — migrations append, never reorder/clear). Idempotent;
// returns the resulting header list. New columns leave existing data rows blank (read as defaults).
function ensureHeaders_(sheet, headers) {
  const lastCol = sheet.getLastColumn();
  const cur = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  const missing = headers.filter(function (h) { return cur.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, 1, 1, cur.length + missing.length).setFontWeight('bold');
  }
  return cur.concat(missing);
}

// Append any CATALOG (constant) card+benefit rows that aren't already in the sheet, matched by
// card+benefit name (case-insensitive). Append-only — never edits/reorders existing rows (PITFALLS
// #2) — so a re-run after shipping new cards adds them without disturbing user edits. Writes each
// value by HEADER NAME (column order independent). Note: a catalog row the user deliberately deleted
// will be re-added on the next setup() (acceptable for a personal tool).
function appendMissingCatalog_(sheet) {
  const lastCol = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const idx = {}; header.forEach(function (h, i) { if (idx[h] == null) idx[h] = i; });
  if (idx['Card'] == null || idx['Benefit'] == null) return;  // unexpected header → don't touch
  const have = {};
  if (sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues().forEach(function (v) {
      const card = String(v[idx['Card']] || '').trim(), benefit = String(v[idx['Benefit']] || '').trim();
      if (card && benefit) have[dedupKey_(card, benefit)] = true;
    });
  }
  const newRows = [];
  Object.keys(CATALOG).forEach(function (card) {
    const entry = CATALOG[card];
    entry.benefits.forEach(function (b) {
      if (have[dedupKey_(card, b.benefit)]) return;
      const row = [];
      for (let i = 0; i < lastCol; i++) row.push('');
      const put = function (name, val) { if (idx[name] != null) row[idx[name]] = val; };
      put('Card', card); put('LastVerified', entry.lastVerified); put('Benefit', b.benefit);
      put('Amount', b.amount); put('Category', b.category); put('Reset', b.reset);
      put('ReminderDays', b.reminderDays); put('SourceUrl', b.sourceUrl || entry.sourceUrl || '');
      put('PeriodBasis', b.periodBasis || 'calendar'); put('Notes', b.notes || '');
      newRows.push(row);
    });
  });
  if (!newRows.length) return;
  const start = sheet.getLastRow() + 1;
  if (idx['LastVerified'] != null) sheet.getRange(start, idx['LastVerified'] + 1, newRows.length, 1).setNumberFormat('@');
  sheet.getRange(start, 1, newRows.length, lastCol).setValues(newRows);
}

// OPT-IN, run once from the editor: upgrade month-only LastVerified cells in an existing Catalog
// sheet to the constant's day-precise date (so the wizard freshness line shows the day). Guarded by
// verifiedDayUpgrade_ — only rewrites a month-only cell whose month matches the constant's, never a
// cell with a hand-entered day, a different month, or a card not in the constant. Idempotent; writes
// plain-text so it never re-coerces. Editor-run like setup() (not web-callable). Returns # changed.
function restampCatalogDay() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CATALOG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const lastCol = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  const idx = {}; header.forEach(function (h, i) { if (idx[h] == null) idx[h] = i; });
  if (idx['Card'] == null || idx['LastVerified'] == null) return 0;
  const lvCol = idx['LastVerified'];
  const n = sheet.getLastRow() - 1;
  const values = sheet.getRange(2, 1, n, lastCol).getValues();
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const card = String(values[i][idx['Card']] || '').trim();
    const entry = CATALOG[card];
    if (!entry || !entry.lastVerified) continue;                 // unknown card → nothing to upgrade to
    const next = verifiedDayUpgrade_(values[i][lvCol], entry.lastVerified);
    if (!next) continue;
    sheet.getRange(i + 2, lvCol + 1, 1, 1).setNumberFormat('@').setValues([[next]]);
    changed++;
  }
  return changed;
}

// Create + seed the editable Catalog sheet from the CATALOG constant. If it already exists (the user
// may have edited it), append any missing columns (SourceUrl/PeriodBasis/Notes migration) AND any
// newly-shipped cards/benefits — existing rows/values are preserved. SourceUrl/Notes seed blank
// (filled by the user); PeriodBasis seeds from the constant so anniversary-basis benefits carry it.
function setupCatalog() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = ss.getSheetByName(CONFIG.CATALOG_SHEET);
  if (existing) { ensureHeaders_(existing, CATALOG_HEADERS); appendMissingCatalog_(existing); return; }
  const sheet = ss.insertSheet(CONFIG.CATALOG_SHEET);
  const rows = [CATALOG_HEADERS];
  Object.keys(CATALOG).forEach(function (card) {
    const entry = CATALOG[card];
    entry.benefits.forEach(function (b) {
      rows.push([card, entry.lastVerified, b.benefit, b.amount, b.category, b.reset, b.reminderDays,
                 b.sourceUrl || entry.sourceUrl || '', b.periodBasis || 'calendar', b.notes || '']);
    });
  });
  // LastVerified is plain-text so Sheets doesn't coerce 'YYYY-MM' into a Date (getCatalogData_ reads
  // it back as a string; coerced cells are still handled by verifiedKey_). Set before writing values.
  sheet.getRange(2, 2, rows.length - 1, 1).setNumberFormat('@');
  sheet.getRange(1, 1, rows.length, CATALOG_HEADERS.length).setValues(rows);
  sheet.getRange(1, 1, 1, CATALOG_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, CATALOG_HEADERS.length);
}

// Create + seed the editable Cards sheet (Card | AnnualFee | OpenDate) from CATALOG defaults if it
// doesn't exist. Idempotent: an existing sheet (which the user may have edited) is left untouched.
// OpenDate is seeded blank for the user to fill; kept plain-text so 'yyyy-MM-dd' never coerces.
function setupCards() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(CONFIG.CARDS_SHEET)) return;
  const sheet = ss.insertSheet(CONFIG.CARDS_SHEET);
  const rows = [CARDS_HEADERS];
  Object.keys(CATALOG).forEach(function (card) {
    rows.push([card, Number(CATALOG[card].annualFee) || 0, '', '', '']);  // Anniversary / seed blank
  });
  sheet.getRange(1, 1, rows.length, CARDS_HEADERS.length).setValues(rows);
  sheet.getRange(1, 1, 1, CARDS_HEADERS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const maxR = sheet.getMaxRows() - 1;
  sheet.getRange(2, 3, maxR, 1).setNumberFormat('@');  // Anniversary 'MM-DD' plain-text
  sheet.getRange(2, 5, maxR, 1).setNumberFormat('@');  // RealizedSeedPeriod (year key) plain-text
  sheet.autoResizeColumns(1, CARDS_HEADERS.length);
}

// ----------------------------- TIME / PERIOD -----------------------------
// basis/anniversary are optional; when a benefit is anniversary-based 'annual', its period key is
// the anniversary-year start year (so done-status holds across the cardmember year, not Jan-Dec).
function periodKey_(reset, date, basis, anniversary) {
  if (isAnniversaryAnnual_(reset, basis)) return String(annualFeePeriodStartYear_(anniversary, date));
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
// Anniversary-based 'annual' benefits end the day before the next anniversary, not Dec 31.
function periodEndDayNumber_(reset, now, basis, anniversary) {
  if (isAnniversaryAnnual_(reset, basis)) {
    return anniversaryDayNumber_(anniversary, annualFeePeriodStartYear_(anniversary, now) + 1) - 1;
  }
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
function periodStartDayNumber_(reset, now, basis, anniversary) {
  if (isAnniversaryAnnual_(reset, basis)) {
    return anniversaryDayNumber_(anniversary, annualFeePeriodStartYear_(anniversary, now));
  }
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
function periodEndDate_(reset, now, basis, anniversary) {
  const end = periodEndDayNumber_(reset, now, basis, anniversary);
  return end === null ? null : new Date(end * 86400000 + 12 * 3600000);
}
// First day of the NEXT period — when a used credit refreshes. Noon-anchored Date; null for 'once'.
function periodRefreshDate_(reset, now, basis, anniversary) {
  const end = periodEndDayNumber_(reset, now, basis, anniversary);
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
function maxSnoozeDays_(reset, now, basis, anniversary) {
  const end = periodEndDayNumber_(reset, now, basis, anniversary);
  return (end === null) ? null : end - dayNumber_(now);
}
function snoozeOptionsFor_(reset, now, basis, anniversary) {
  const maxD = maxSnoozeDays_(reset, now, basis, anniversary);
  return SNOOZE_PRESETS.filter(function (d) { return maxD === null || d <= maxD; });
}
// Pure: the day number a snooze should land on, clamped to the current period so it never overshoots
// expiry. Returns null when the benefit can't be snoozed (expires today/already, or a bad date).
//   action 'snooze'     → `arg` is a day count
//   action 'snoozeEnd'  → through period end ("Never"); no-expiry ('once') → effectively forever
//   action 'snoozeDate' → `arg` is a 'yyyy-MM-dd' target, clamped to [tomorrow, period end]
function snoozeUntilDayNumber_(action, reset, now, arg, basis, anniversary) {
  const todayNum = dayNumber_(now);
  const endNum = periodEndDayNumber_(reset, now, basis, anniversary);   // null = no expiry ('once')
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

// ----------------------- ANNUAL-FEE PERIOD + REALIZED VALUE -----------------------
// These power the per-card "realized value / annual fee" progress bar. Realized value accumulates
// over the annual-fee period — the cardmember ANNIVERSARY year counted from the card's open date —
// and resets at each anniversary (the fee is billed per cardmember year, so "has it paid for
// itself" is measured over that same year). NOT the calendar year. Kept pure + tz-safe.
//
// NOTE: this is a SEPARATE calculation used only for the fee bar's accumulator. It does NOT change
// each benefit's own calendar reset (periodKey_ / periodStartDayNumber_ / …) — that's backlog #3.

// Numeric dollar value of a free-text Amount, or null when there isn't one. A '$' value wins
// ($12.95 → 12.95, $300 → 300); else a bare number counts (10 → 10); else null. "12 visits" and
// "Unlimited" have no '$' and aren't bare numbers, so → null (never counted toward the bar).
function parseAmount_(s) {
  const str = String(s == null ? '' : s).trim();
  const dollar = str.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (dollar) return Number(dollar[1]);
  if (/^\d+(?:\.\d+)?$/.test(str)) return Number(str);
  return null;
}

// Display form of an amount: prefix '$' to a bare dollar number (sheet rows sometimes store
// "300" instead of "$300"). Anything already containing '$', or non-$ text (e.g. 'Priority
// Pass', '12 visits'), is returned untouched — never double-prefixed, never coerced.
function displayAmount_(s) {
  const str = String(s == null ? '' : s).trim();
  if (str && str.indexOf('$') === -1 && /^\d+(?:\.\d+)?$/.test(str)) return '$' + str;
  return str;
}

// Month/day of an anniversary → {om, od}. Accepts 'MM-DD' (the stored form), bare 'M-D', and a
// legacy 'yyyy-MM-DD'. Blank / unparseable / out-of-range falls back to Jan 1 ({om:1, od:1}) so the
// annual-fee period (and anniversary resets) degrade predictably to the calendar year.
function parseMonthDay_(anniversary) {
  const m = String(anniversary == null ? '' : anniversary).match(/^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/);
  if (!m) return { om: 1, od: 1 };
  const om = Number(m[1]), od = Number(m[2]);
  if (om < 1 || om > 12 || od < 1 || od > 31) return { om: 1, od: 1 };
  return { om: om, od: od };
}

// Day number (script-tz day count, like dayNumber_) of the anniversary in a given year. A Feb-29
// anniversary approximates to Feb-28.
function anniversaryDayNumber_(anniversary, year) {
  const md = parseMonthDay_(anniversary);
  let om = md.om, od = md.od;
  if (om === 2 && od === 29) od = 28;
  return Math.floor(Date.UTC(year, om - 1, od) / 86400000);
}

// The current annual-fee period, identified by its START YEAR (integer). The period runs from the
// anniversary month/day this-or-last year to the next anniversary; today on/after this year's
// anniversary ⇒ the period started this year, else last year. Blank anniversary ⇒ Jan 1 ⇒ calendar.
function annualFeePeriodStartYear_(anniversary, now) {
  const tz = Session.getScriptTimeZone();
  const y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const m = Number(Utilities.formatDate(now, tz, 'MM'));
  const d = Number(Utilities.formatDate(now, tz, 'dd'));
  const md = parseMonthDay_(anniversary);
  const past = (m > md.om) || (m === md.om && d >= md.od);  // today on/after this year's anniversary?
  return past ? y : y - 1;
}

// The next anniversary Date (start year + 1) — shown as "resets <date>". Noon-anchored + tz-safe.
function annualFeeResetDate_(anniversary, now) {
  const dn = anniversaryDayNumber_(anniversary, annualFeePeriodStartYear_(anniversary, now) + 1);
  return new Date(dn * 86400000 + 12 * 3600000);
}

// True for benefits whose period rolls on the card anniversary instead of the calendar. Only
// 'annual' benefits are anniversary-based (#3: CSP hotel, CSR travel); everything else stays
// calendar. periodBasis is sourced from the CATALOG (issuer-determined) via benefitPeriodBasis_.
function isAnniversaryAnnual_(reset, basis) { return basis === 'anniversary' && reset === 'annual'; }

// The benefit's period basis ('anniversary' | 'calendar'), sourced from the CATALOG by card +
// benefit name (issuer-determined, not user-set — so no per-benefit UI or stored column). Unknown
// card/benefit (manual adds, renamed rows) → 'calendar'. Used to derive row.periodBasis on read.
function benefitPeriodBasis_(card, benefit) {
  const ck = cardKey_(card), bk = String(benefit == null ? '' : benefit).toLowerCase().trim();
  let basis = 'calendar';
  Object.keys(CATALOG).forEach(function (name) {
    if (cardKey_(name) !== ck) return;
    CATALOG[name].benefits.forEach(function (b) {
      if (String(b.benefit).toLowerCase().trim() === bk && b.periodBasis === 'anniversary') basis = 'anniversary';
    });
  });
  return basis;
}

// Pure accumulator: the new {value, period} after a benefit toggles not-done → done. If the stored
// value already belongs to the current fee period it accumulates; otherwise it's stale (a past
// period) and resets to just this done's amount. A non-$ amount adds 0. Caller writes cols 11/12.
function realizedAfterDone_(prevValue, prevPeriod, afYear, amount) {
  const base = (Number(prevPeriod) === afYear) ? (Number(prevValue) || 0) : 0;
  const amt = parseAmount_(amount);
  return { value: base + (amt == null ? 0 : amt), period: afYear };
}

// Undo counterpart: subtract this benefit's amount, but only when the stored value is from the
// current period (else there's nothing in this period to reverse); floor at 0. Returns the new value.
function realizedAfterUndo_(prevValue, prevPeriod, afYear, amount) {
  if (Number(prevPeriod) !== afYear) return Number(prevValue) || 0;
  const amt = parseAmount_(amount);
  const next = (Number(prevValue) || 0) - (amt == null ? 0 : amt);
  return next < 0 ? 0 : next;
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
// Catalog PeriodBasis cell → 'anniversary' | 'calendar' (default). Blank/unknown → calendar.
function normalizeBasis_(v) {
  return String(v == null ? '' : v).toLowerCase().trim() === 'anniversary' ? 'anniversary' : 'calendar';
}
function readRows_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) return { sheet: null, rows: [], missing: true };
  const last = sheet.getLastRow();
  if (last < 2) return { sheet: sheet, rows: [], missing: false };
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const metaMap = getCardMetaMap_();  // per-card anniversary, for anniversary-basis resets (#3)
  const rows = values.map(function (v, i) {
    const card = v[COL.CARD - 1];
    const benefit = v[COL.BENEFIT - 1];
    return {
      rowIndex: i + 2,
      id: String(v[COL.ID - 1]),
      card: card,
      benefit: benefit,
      amount: v[COL.AMOUNT - 1],
      category: v[COL.CATEGORY - 1],
      reset: normalizeReset_(v[COL.RESET - 1]),
      reminderDays: Number(v[COL.REMINDER_DAYS - 1]) || CONFIG.DEFAULT_REMINDER_DAYS,
      lastDonePeriod: String(v[COL.LAST_DONE_PERIOD - 1] || ''),
      lastReminded: v[COL.LAST_REMINDED - 1] ? new Date(v[COL.LAST_REMINDED - 1]) : null,
      snoozeUntil: v[COL.SNOOZE_UNTIL - 1] ? new Date(v[COL.SNOOZE_UNTIL - 1]) : null,
      realizedValue: Number(v[COL.REALIZED_VALUE - 1]) || 0,
      realizedPeriod: String(v[COL.REALIZED_PERIOD - 1] || ''),
      // #3: a benefit's reset basis is issuer-fixed (derived from CATALOG by name); its card's
      // anniversary (MM-DD) anchors the period when that basis is 'anniversary'.
      periodBasis: benefitPeriodBasis_(card, benefit),
      anniversary: (metaMap[cardKey_(card)] || {}).anniversary || '',
    };
  });
  return { sheet: sheet, rows: rows, missing: false };
}
function isDone_(row, now) { return row.lastDonePeriod === periodKey_(row.reset, now, row.periodBasis, row.anniversary); }
function isSnoozed_(row, now) { return !!(row.snoozeUntil && now < row.snoozeUntil); }

// ----------------------------- CARDS (meta) -----------------------------
// Per-card annual fee + open date, read from the Cards sheet. Powers the realized-value bar.
function cardKey_(card) { return String(card == null ? '' : card).toLowerCase().trim(); }

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
// A stored Anniversary normalized to 'MM-DD' (or '' if blank/invalid). Accepts 'MM-DD', bare 'M-D',
// a legacy 'yyyy-MM-DD', and a Date (in case the user typed into the sheet and Sheets coerced it).
function normalizeAnniversary_(v) {
  if (v == null || v === '') return '';
  let s;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    s = Utilities.formatDate(v, Session.getScriptTimeZone(), 'MM-dd');
  } else { s = String(v).trim(); }
  const m = s.match(/^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/);
  if (!m) return '';
  const om = Number(m[1]), od = Number(m[2]);
  if (om < 1 || om > 12 || od < 1 || od > 31) return '';
  return pad2_(om) + '-' + pad2_(od);
}

function readCardsSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CARDS_SHEET);
  if (!sheet) return { sheet: null, rows: [], missing: true };
  const last = sheet.getLastRow();
  if (last < 2) return { sheet: sheet, rows: [], missing: false };
  const values = sheet.getRange(2, 1, last - 1, CARDS_HEADERS.length).getValues();
  const rows = values.map(function (v, i) {
    return {
      rowIndex: i + 2,
      card: String(v[0] == null ? '' : v[0]).trim(),
      annualFee: Number(v[1]) || 0,
      anniversary: normalizeAnniversary_(v[2]),
      realizedSeed: Number(v[3]) || 0,
      realizedSeedPeriod: String(v[4] == null ? '' : v[4]).trim(),
    };
  });
  return { sheet: sheet, rows: rows, missing: false };
}

// All cards' meta, keyed by cardKey_ — read once per dashboard render (not per row).
function getCardMetaMap_() {
  const map = {};
  readCardsSheet_().rows.forEach(function (r) {
    if (r.card) map[cardKey_(r.card)] = {
      annualFee: r.annualFee, anniversary: r.anniversary,
      realizedSeed: r.realizedSeed, realizedSeedPeriod: r.realizedSeedPeriod,
    };
  });
  return map;
}
function getCardMeta_(card) {
  return getCardMetaMap_()[cardKey_(card)] ||
    { annualFee: 0, anniversary: '', realizedSeed: 0, realizedSeedPeriod: '' };
}

// Header-only creator used by setCardMeta when the Cards sheet doesn't exist yet (e.g. an old
// deployment that hasn't re-run setup()). setup()/setupCards() seeds the catalog defaults.
function ensureCardsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.CARDS_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CONFIG.CARDS_SHEET);
  sheet.getRange(1, 1, 1, CARDS_HEADERS.length).setValues([CARDS_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

// Upsert one card's annual fee + anniversary + realized-seed (google.script.run, from the add/edit
// wizard). Auth + lock. Fee/seed coerced to non-negative numbers; Anniversary stored plain-text
// 'MM-DD'. The seed is stamped with the current annual-fee period so it lazily resets at the
// anniversary (a 0 seed clears the period stamp).
function setCardMeta(card, annualFee, anniversary, realizedSeed) {
  requireAuth_();
  const cardName = String(card == null ? '' : card).trim();
  if (!cardName) throw new Error(t_('addNeedCardName'));
  const fee = Number(annualFee);
  const feeVal = (isFinite(fee) && fee >= 0) ? fee : 0;
  const ann = normalizeAnniversary_(anniversary);
  const seedN = Number(realizedSeed);
  const seedVal = (isFinite(seedN) && seedN > 0) ? seedN : 0;
  const seedPeriod = seedVal > 0 ? String(annualFeePeriodStartYear_(ann, new Date())) : '';
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureCardsSheet_();
    const key = cardKey_(cardName);
    const existing = readCardsSheet_().rows.filter(function (r) { return cardKey_(r.card) === key; })[0];
    const rowIndex = existing ? existing.rowIndex : sheet.getLastRow() + 1;
    sheet.getRange(rowIndex, 1, 1, CARDS_HEADERS.length).setValues([[cardName, feeVal, ann, seedVal, seedPeriod]]);
    sheet.getRange(rowIndex, 3).setNumberFormat('@').setValue(ann);          // Anniversary plain-text
    sheet.getRange(rowIndex, 5).setNumberFormat('@').setValue(seedPeriod);   // seed period plain-text
    return { card: cardName, annualFee: feeVal, anniversary: ann, realizedSeed: seedVal };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------- CATALOG (read) -----------------------------
function validCategory_(c) {
  const v = String(c == null ? '' : c).toLowerCase().trim();
  return CATEGORIES.indexOf(v) !== -1 ? v : 'other';
}

// A catalog LastVerified cell can be a 'YYYY-MM' / 'YYYY-MM-DD' string OR — if Sheets coerced it
// (the column isn't plain-text) — a Date. Normalize to the canonical string key ('' when
// unrecognized) so display + staleness are robust to coercion.
function verifiedKey_(v) {
  // toString tag, not `instanceof Date` — robust across execution realms (and the verify vm context).
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM');
  const s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}(-\d{2})?$/.test(s) ? s : '';
}
// Friendly label for a verified value: 'YYYY-MM' → "Jun 2026" / "2026年6月"; 'YYYY-MM-DD' adds the
// day. '' when unrecognized. Built UTC-noon so script-tz formatting never slips a month.
function verifiedLabel_(v) {
  const key = verifiedKey_(v);
  const m = key.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = m[3] ? Number(m[3]) : 0;
  if (CONFIG.LANG === 'zh') return d ? (y + '年' + mo + '月' + d + '日') : (y + '年' + mo + '月');
  const date = new Date(Date.UTC(y, mo - 1, d || 1, 12));
  return Utilities.formatDate(date, Session.getScriptTimeZone(), d ? 'MMM d, yyyy' : 'MMM yyyy');
}

// Decide whether to upgrade a LastVerified cell from month-only to the constant's day-precise date.
// Returns the full 'YYYY-MM-DD' to write, or '' to leave the cell as-is. Upgrades ONLY when the cell
// normalizes to a month-only key ('YYYY-MM', incl. a Sheets-coerced Date) AND that month equals the
// constant's month — so a user's hand-entered day or a different month is never overwritten. Pure;
// idempotent (a cell that already has a day → ''). Used by the opt-in restampCatalogDay() migration.
function verifiedDayUpgrade_(cellValue, fullDate) {
  const full = verifiedKey_(fullDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(full)) return '';   // constant must itself be day-precise
  const key = verifiedKey_(cellValue);
  if (!/^\d{4}-\d{2}$/.test(key)) return '';           // blank / unparseable / already has a day → leave it
  return key === full.slice(0, 7) ? full : '';         // same month → upgrade; different month → leave it
}

// Whole months between a 'YYYY-MM' / 'YYYY-MM-DD' (or coerced-Date) LastVerified and `now`; null if
// unparseable. Day is ignored (row-level freshness is month-grained). Shared by the wizard's
// staleness warning and reviewStaleCatalog(). Pure (tz via stubs) so verify can pin it.
function monthsSinceVerified_(lastVerified, now) {
  const m = verifiedKey_(lastVerified).match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  const tz = Session.getScriptTimeZone();
  const nowY = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const nowMo = Number(Utilities.formatDate(now, tz, 'MM'));
  return (nowY - y) * 12 + (nowMo - mo);
}
// True when a catalog entry's LastVerified is at least CATALOG_REVIEW_AFTER_MONTHS old. Unparseable
// / blank dates are NOT flagged stale (avoids nagging about hand-entered rows with no date).
function catalogStale_(lastVerified, now) {
  const months = monthsSinceVerified_(lastVerified, now);
  return months !== null && months >= CONFIG.CATALOG_REVIEW_AFTER_MONTHS;
}

// The catalog as the wizard consumes it:
//   { cards: [{ card, lastVerified, sourceUrl, benefits:[{ ..., sourceUrl, periodBasis, notes }] }] }
// Prefers the editable Catalog sheet (so user edits win); falls back to the CATALOG constant. Reads
// the sheet by HEADER NAME (not column position), so old 7-column and new 10-column sheets both work.
// Not auth-gated itself — callers (getCatalog / addCardsPage_) sit behind requireAuth_ / doGet.
function getCatalogData_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CATALOG_SHEET);
  if (sheet && sheet.getLastRow() >= 2) {
    const lastCol = sheet.getLastColumn();
    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    const idx = {};
    header.forEach(function (h, i) { if (idx[h] == null) idx[h] = i; });
    const col = function (v, name) { const i = idx[name]; return i == null ? '' : v[i]; };
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
    const byCard = {};
    const order = [];
    values.forEach(function (v) {
      const card = String(col(v, 'Card') || '').trim();
      const benefit = String(col(v, 'Benefit') || '').trim();
      if (!card || !benefit) return;  // skip blank/partial rows
      const lastVerified = verifiedKey_(col(v, 'LastVerified'));  // Date-coercion safe
      const sourceUrl = String(col(v, 'SourceUrl') || '').trim();
      if (!byCard[card]) { byCard[card] = { card: card, annualFee: (CATALOG[card] ? Number(CATALOG[card].annualFee) || 0 : 0), lastVerified: lastVerified, lastVerifiedLabel: verifiedLabel_(lastVerified), sourceUrl: sourceUrl, benefits: [] }; order.push(card); }
      if (!byCard[card].lastVerified && lastVerified) { byCard[card].lastVerified = lastVerified; byCard[card].lastVerifiedLabel = verifiedLabel_(lastVerified); }  // first non-blank wins
      if (!byCard[card].sourceUrl && sourceUrl) byCard[card].sourceUrl = sourceUrl;
      byCard[card].benefits.push({
        benefit: benefit,
        amount: String(col(v, 'Amount') || ''),
        category: validCategory_(col(v, 'Category')),
        reset: normalizeReset_(col(v, 'Reset')),
        reminderDays: Number(col(v, 'ReminderDays')) || CONFIG.DEFAULT_REMINDER_DAYS,
        sourceUrl: sourceUrl,
        periodBasis: normalizeBasis_(col(v, 'PeriodBasis')),
        notes: String(col(v, 'Notes') || '').trim(),
        lastVerified: lastVerified,
      });
    });
    return { cards: order.map(function (k) { return byCard[k]; }) };
  }
  // Fallback: the shipped constant (with the same new fields, defaulted).
  return {
    cards: Object.keys(CATALOG).map(function (card) {
      const entry = CATALOG[card];
      return {
        card: card,
        annualFee: Number(entry.annualFee) || 0,
        lastVerified: entry.lastVerified,
        lastVerifiedLabel: verifiedLabel_(entry.lastVerified),
        sourceUrl: entry.sourceUrl || '',
        benefits: entry.benefits.map(function (b) {
          return { benefit: b.benefit, amount: b.amount, category: validCategory_(b.category),
                   reset: normalizeReset_(b.reset), reminderDays: Number(b.reminderDays) || CONFIG.DEFAULT_REMINDER_DAYS,
                   sourceUrl: b.sourceUrl || entry.sourceUrl || '', periodBasis: b.periodBasis || 'calendar',
                   notes: b.notes || '', lastVerified: entry.lastVerified };
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
  const cardName = rows.length ? rows[0].card : card;
  const m = getCardMeta_(cardName);
  const now = new Date();
  const afYear = annualFeePeriodStartYear_(m.anniversary, now);
  const effSeed = (String(m.realizedSeedPeriod) === String(afYear)) ? m.realizedSeed : 0;
  // Catalog freshness for this card, surfaced in the edit form (same note as add mode).
  const fresh = cat
    ? { lastVerified: cat.lastVerified, lastVerifiedLabel: cat.lastVerifiedLabel, sourceUrl: cat.sourceUrl, stale: catalogStale_(cat.lastVerified, now) }
    : { lastVerified: '', lastVerifiedLabel: '', sourceUrl: '', stale: false };
  return {
    card: cardName,
    freshness: fresh,
    benefits: rows.map(function (r) {
      return { id: r.id, benefit: r.benefit, amount: r.amount, category: validCategory_(r.category),
               reset: r.reset, reminderDays: r.reminderDays,
               custom: !catNames[String(r.benefit).toLowerCase().trim()] };  // true = user-added (not in catalog)
    }),
    suggestions: suggestions,
    // Prefilled into the edit form. Seed shown only when it belongs to the current period (a stale
    // seed reads as 0, so re-saving the card won't accidentally revive it).
    meta: { annualFee: m.annualFee, anniversary: m.anniversary, realizedSeed: effSeed },
  };
}

// ----------------------------- REMINDERS -----------------------------
// Period-driven: nudge once when a new period starts ("you have a fresh credit"), and once more as
// it nears expiry ("use it before it resets"). LastReminded (a date) is the only stored state — we
// compare its day number against each trigger day, so each nudge fires at most once per period and
// the base cadence follows the reset frequency itself (no per-benefit ReminderDays needed). In
// 'persistent' cadence (CONFIG.REMINDER_CADENCE) the near-expiry nudge also REPEATS every
// `repeatDays` until the benefit is done/snoozed. cadence/repeatDays are params (default from CONFIG)
// so verify can pin both modes.
function shouldRemind_(row, now, cadence, repeatDays) {
  cadence = cadence || CONFIG.REMINDER_CADENCE;
  repeatDays = repeatDays || CONFIG.REMINDER_REPEAT_DAYS;
  const today = dayNumber_(now);
  const lr = row.lastReminded ? dayNumber_(row.lastReminded) : -Infinity;
  const start = periodStartDayNumber_(row.reset, now, row.periodBasis, row.anniversary);
  if (today >= start && lr < start) return true;                 // start-of-period nudge
  const end = periodEndDayNumber_(row.reset, now, row.periodBasis, row.anniversary);
  if (end !== null) {
    const windowStart = end - reminderLeadDays_(row.reset) + 1;
    if (today >= windowStart && lr < windowStart) return true;   // first near-expiry nudge
    if (cadence === 'persistent' &&                              // re-nudge through the expiry window
        today >= windowStart && today <= end && today - lr >= repeatDays) return true;
  }
  return false;
}

// The next day a reminder will fire for this row, given its stored lastReminded — mirrors
// shouldRemind_ (including persistent repeats) so the previewReminders() diagnostic can answer
// "when's the next email?". Returns today's day number when a nudge is already due, or null for a
// 'once' benefit whose single nudge has passed. cadence/repeatDays default from CONFIG. Pure.
function nextReminderDayNumber_(row, now, cadence, repeatDays) {
  cadence = cadence || CONFIG.REMINDER_CADENCE;
  repeatDays = repeatDays || CONFIG.REMINDER_REPEAT_DAYS;
  const today = dayNumber_(now);
  const lr = row.lastReminded ? dayNumber_(row.lastReminded) : -Infinity;
  if (shouldRemind_(row, now, cadence, repeatDays)) return today; // overdue / due today
  const end = periodEndDayNumber_(row.reset, now, row.periodBasis, row.anniversary);
  if (end === null) return null;                                  // 'once', start nudge already sent
  const windowStart = end - reminderLeadDays_(row.reset) + 1;
  if (lr < windowStart && windowStart > today) return windowStart; // first near-expiry nudge still ahead
  if (cadence === 'persistent' && lr >= windowStart && lr < end) {
    const repeat = lr + repeatDays;                              // next in-window re-nudge (> today here)
    if (repeat <= end) return repeat;
  }
  return end + 1;                                                 // otherwise next period's start nudge
}
// Same, as a noon-anchored Date (or null) for display.
function nextReminderDate_(row, now, cadence, repeatDays) {
  const d = nextReminderDayNumber_(row, now, cadence, repeatDays);
  return d === null ? null : new Date(d * 86400000 + 12 * 3600000);
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

// Read-only diagnostic — run manually from the editor (Run ▸ previewReminders). Sends no email and
// writes nothing; it just logs whether the daily trigger is installed and, for every tracked
// benefit, its done/snooze state plus the next date a reminder will fire. Use it to confirm the
// engine is healthy without waiting for 9am (a quiet, email-free day mid-period is expected — a
// nudge fires only at the start of a period and once near expiry). No trailing underscore, or it
// would not show up in the editor's Run dropdown (PITFALLS #16).
function previewReminders() {
  requireAuth_();
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const triggers = ScriptApp.getProjectTriggers().filter(function (tr) {
    return tr.getHandlerFunction() === 'sendReminders';
  });
  Logger.log('Reminder email → ' + CONFIG.EMAIL + ' at ~' + CONFIG.DAILY_HOUR + ':00 (' + tz + ')');
  Logger.log('sendReminders trigger installed: ' +
    (triggers.length ? 'yes (' + triggers.length + ')' : 'NO — run setup() to (re)create it'));

  const data = readRows_();
  if (data.missing) { Logger.log('No Benefits sheet — run setup() first.'); return { missing: true }; }
  if (!data.rows.length) { Logger.log('No benefits tracked yet.'); return { rows: [] }; }

  const report = data.rows.map(function (row) {
    const done = isDone_(row, now);
    const snoozed = isSnoozed_(row, now);
    const dueNow = !done && !snoozed && shouldRemind_(row, now);
    const next = nextReminderDate_(row, now);
    return {
      card: row.card, benefit: row.benefit, done: done, snoozed: snoozed, dueNow: dueNow,
      next: next ? fmtShortDate_(next) : '—',
    };
  });
  const dueCount = report.filter(function (r) { return r.dueNow; }).length;
  Logger.log('Would email now: ' + dueCount + ' benefit(s).' +
    (dueCount ? '' : ' (nothing due — a quiet day mid-period is expected.)'));
  report.forEach(function (r) {
    const state = r.done ? 'done' : (r.snoozed ? 'snoozed' : (r.dueNow ? 'DUE NOW' : 'waiting'));
    Logger.log('• ' + r.card + ' — ' + r.benefit + ' | ' + state + ' | next reminder: ' + r.next);
  });
  return { dueCount: dueCount, report: report };
}

function reminderHtml_(due) {
  const url = webAppUrl_();
  const now = new Date();
  const heading = due.length === 1
    ? t_('emailHeadingOne')
    : fmt_(t_('emailHeadingMany'), { n: due.length });

  let html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px">';
  html += '<h2 style="font-weight:500;color:#1a1a18">' + esc_(heading) + '</h2>';
  html += '<table style="width:100%;border-collapse:collapse">';
  due.forEach(function (row) {
    const doneUrl = actionUrl_(url, 'done', row.id, '');
    const snoozeUrl = actionUrl_(url, 'snooze', row.id, '&days=' + CONFIG.SNOOZE_DEFAULT_DAYS);
    const endNum = periodEndDayNumber_(row.reset, now, row.periodBasis, row.anniversary);  // null = no expiry ('once')
    const daysLeft = (endNum === null) ? null : endNum - dayNumber_(now);
    const expiry = (endNum === null) ? '' : (daysLeft <= 0 ? t_('expiryToday')
      : fmt_(t_('expiryInfo'), { n: daysLeft, date: fmtShortDate_(periodEndDate_(row.reset, now, row.periodBasis, row.anniversary)) }));
    html +=
      '<tr style="border-bottom:1px solid #e6e4dc">' +
        '<td style="padding:12px 8px 12px 0;vertical-align:top">' +
          '<div style="font-size:15px;color:#1a1a18">' + esc_(row.benefit) + ' — ' + esc_(displayAmount_(row.amount)) + '</div>' +
          '<div style="font-size:13px;color:#6b6a64">' + esc_(row.card) + ' · ' +
            esc_(t_('resets')) + ' ' + esc_(resetLabel_(row.reset)) +
            (expiry ? ' · ' + esc_(expiry) : '') + '</div>' +
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

// Catalog cards whose LastVerified is older than CATALOG_REVIEW_AFTER_MONTHS. Pure (now injected),
// so verify can pin the selection independent of the wall clock.
function staleCatalogCards_(cards, now) {
  return (cards || []).filter(function (c) { return catalogStale_(c.lastVerified, now); });
}

// Monthly stale-catalog review (time trigger at CATALOG_REVIEW_HOUR; Apps Script passes an event arg
// we ignore). READ-ONLY by design: emails CONFIG.EMAIL a list of cards whose catalog terms are due
// for a manual re-check, with source links — it NEVER mutates the catalog or tracked benefits
// (issuer pages have footnotes/targeted offers; auto-applying changes could silently corrupt data).
function reviewStaleCatalog() {
  const now = new Date();
  const cards = staleCatalogCards_(getCatalogData_().cards, now);
  if (!cards.length) return;  // nothing stale → no email
  MailApp.sendEmail({
    to: CONFIG.EMAIL,
    subject: fmt_(t_('catalogReviewSubject'), { n: cards.length }),
    htmlBody: catalogReviewHtml_(cards, now),
  });
}

function catalogReviewHtml_(cards, now) {
  const url = webAppUrl_();
  let html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:560px">';
  html += '<h2 style="font-weight:500;color:#1a1a18">' + esc_(fmt_(t_('catalogReviewHeading'), { n: cards.length })) + '</h2>';
  html += '<p style="font-size:13px;color:#6b6a64;line-height:1.5">' + esc_(t_('catalogReviewIntro')) + '</p>';
  cards.forEach(function (c) {
    const months = monthsSinceVerified_(c.lastVerified, now);
    html += '<div style="border-top:1px solid #e6e4dc;padding:12px 0">';
    html += '<div style="font-size:15px;color:#1a1a18">' + esc_(c.card) + '</div>';
    html += '<div style="font-size:13px;color:#6b6a64">' +
      esc_(fmt_(t_('catalogReviewVerified'), { date: c.lastVerifiedLabel || '—', months: (months == null ? '?' : months) })) + '</div>';
    const su = /^https?:\/\//i.test(String(c.sourceUrl || '')) ? c.sourceUrl : '';
    if (su) html += '<a href="' + esc_(su) + '" style="color:#185FA5;font-size:13px">' + esc_(t_('catalogReviewSource')) + ' →</a>';
    html += '</div>';
  });
  html += '<p style="margin-top:20px"><a href="' + url + '" style="color:#185FA5">' +
    esc_(t_('openDashboard')) + '</a></p></div>';
  return html;
}

// Prefer the pinned WEBAPP_URL Script Property (deterministic across trigger/editor/web contexts);
// fall back to the active deployment's URL when it's not set. From a trigger context
// getService().getUrl() can resolve to a stale/broken deployment (PITFALLS #15).
function webAppUrl_() {
  return pinnedWebAppUrl_() || ScriptApp.getService().getUrl();
}

function pinnedWebAppUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '').trim();
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
  tpl.addUrl = webAppUrl_() + '?view=add';
  return tpl.evaluate()
    .setTitle(t_('dashTitle'))
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function addCardsPage_(params) {
  const tpl = HtmlService.createTemplateFromFile('AddCards');
  const cat = getCatalogData_();
  const now = new Date();
  cat.cards.forEach(function (c) { c.stale = catalogStale_(c.lastVerified, now); });  // wizard freshness warning
  tpl.catalogJson = jsonForHtml_(cat);
  tpl.uiJson = jsonForHtml_(addUiStrings_());
  tpl.metaJson = jsonForHtml_(getCardMetaMap_());  // {cardKey: {annualFee, openDate}} — add-mode fee prefill
  tpl.dashUrl = webAppUrl_();
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
    const maxD = maxSnoozeDays_(row.reset, new Date(), row.periodBasis, row.anniversary);  // capped value in the question
    if (maxD !== null && maxD >= 1) days = Math.min(days, maxD);
  }
  const question = action === 'done'
    ? fmt_(t_('confirmDoneQ'), { name: row.benefit })
    : fmt_(t_('confirmSnoozeQ'), { name: row.benefit, d: days });

  const tpl = HtmlService.createTemplateFromFile('Confirm');
  tpl.question = question;
  tpl.dashUrl = webAppUrl_();
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
        rd, '', '', '', '', '',
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

// Transient case-insensitive card+benefit key for in-call dedup (never persisted). JSON.stringify
// gives a visible, collision-proof separator — this once used a literal NUL byte, which made
// `file Code.gs` report binary and forced `grep -a` / `rg --text` all session.
function dedupKey_(card, benefit) {
  return JSON.stringify([String(card).toLowerCase().trim(), String(benefit).toLowerCase().trim()]);
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

    const list = (items || []);
    const normItem_ = function (it) {
      const benefit = String(it && it.benefit != null ? it.benefit : '').trim();
      let rd = Math.round(Number(it && it.reminderDays));
      if (!(rd >= 1)) rd = CONFIG.DEFAULT_REMINDER_DAYS;
      const vals = [benefit, String(it && it.amount != null ? it.amount : '').trim(),
                    validCategory_(it && it.category), normalizeReset_(it && it.reset)];
      return { benefit: benefit, rd: rd, vals: vals, id: it && it.id ? String(it.id) : '' };
    };

    // Pass 1 — resubmitted existing rows (update in place / keep). Seed the dedup set with each
    // kept row's (possibly edited) name so a new row in pass 2 can't duplicate a surviving benefit.
    const updates = [], newRows = [], keep = {}, seen = {};
    list.forEach(function (it) {
      const n = normItem_(it);
      if (!n.benefit || !(n.id && existing[n.id])) return;
      const cur = existing[n.id];
      keep[n.id] = true;  // resubmitted → keep the row even when nothing changed
      seen[dedupKey_(cardName, n.benefit)] = true;
      // Only treat it as an update (write + report) if a field actually differs from the stored
      // row. The wizard resubmits every prefilled row unchanged, so without this diff the
      // "Updated:" summary would list untouched benefits and inflate the count. Compare against
      // the same normalization the new vals went through (category/reset/trim).
      const changed =
        n.vals[0] !== String(cur.benefit == null ? '' : cur.benefit).trim() ||
        n.vals[1] !== String(cur.amount == null ? '' : cur.amount).trim() ||
        n.vals[2] !== validCategory_(cur.category) ||
        n.vals[3] !== normalizeReset_(cur.reset) ||
        n.rd !== cur.reminderDays;
      if (changed) updates.push({ rowIndex: cur.rowIndex, vals: n.vals, rd: n.rd });
    });

    // Pass 2 — new rows (no id, or an id not on this card). Skip any that collide with a kept row
    // or an earlier new row, so edit mode can't introduce a duplicate benefit name (review #5).
    list.forEach(function (it) {
      const n = normItem_(it);
      if (!n.benefit || (n.id && existing[n.id])) return;  // handled in pass 1
      const k = dedupKey_(cardName, n.benefit);
      if (seen[k]) return;
      seen[k] = true;
      const newId = uniqueId_(cardName, n.benefit, usedId);
      usedId[newId] = true;
      newRows.push([newId, cardName, n.vals[0], n.vals[1], n.vals[2], n.vals[3], n.rd, '', '', '', '', '']);
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
      // Accumulate realized value only on the real not-done → done transition (so re-tapping done
      // is idempotent and never double-counts). wasDone reads the OLD lastDonePeriod, before we
      // overwrite it below. Cross-period stored values reset inside realizedAfterDone_.
      const wasDone = isDone_(row, now);
      if (!wasDone) {
        const afYear = annualFeePeriodStartYear_(row.anniversary, now);
        const r = realizedAfterDone_(row.realizedValue, row.realizedPeriod, afYear, row.amount);
        data.sheet.getRange(row.rowIndex, COL.REALIZED_VALUE).setValue(r.value);
        data.sheet.getRange(row.rowIndex, COL.REALIZED_PERIOD).setNumberFormat('@').setValue(String(r.period));
      }
      // Force plain-text format first, or Sheets coerces a monthly key like "2026-06" into a
      // Date — which then never matches periodKey_() on read (the benefit looks un-done).
      data.sheet.getRange(row.rowIndex, COL.LAST_DONE_PERIOD)
        .setNumberFormat('@').setValue(periodKey_(row.reset, now, row.periodBasis, row.anniversary));
      data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL).setValue('');
      return { ok: true, key: 'doneOk', name: row.benefit };
    }
    if (action === 'undo') {
      // Reverse the realized value only when this undo actually reverses a done in the CURRENT fee
      // period (else there's nothing in this period to subtract); floor at 0.
      if (isDone_(row, now)) {
        const afYear = annualFeePeriodStartYear_(row.anniversary, now);
        if (Number(row.realizedPeriod) === afYear) {
          data.sheet.getRange(row.rowIndex, COL.REALIZED_VALUE)
            .setValue(realizedAfterUndo_(row.realizedValue, row.realizedPeriod, afYear, row.amount));
        }
      }
      data.sheet.getRange(row.rowIndex, COL.LAST_DONE_PERIOD).setValue('');
      return { ok: true, key: 'undoOk', name: row.benefit };
    }
    if (action === 'unsnooze') {
      data.sheet.getRange(row.rowIndex, COL.SNOOZE_UNTIL).setValue('');
      return { ok: true, key: 'unsnoozeOk', name: row.benefit };
    }
    // snooze variants ('snooze' day-count · 'snoozeEnd' = "Never" · 'snoozeDate' = picked date),
    // all clamped so the return never lands past the benefit's expiry (see snoozeUntilDayNumber_).
    const untilNum = snoozeUntilDayNumber_(action, row.reset, now, days, row.periodBasis, row.anniversary);
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
  const metaMap = getCardMetaMap_();
  const cards = {};
  const order = [];
  data.rows.forEach(function (row) {
    if (!cards[row.card]) {
      const meta = metaMap[cardKey_(row.card)] || { annualFee: 0, anniversary: '', realizedSeed: 0, realizedSeedPeriod: '' };
      const afYear = annualFeePeriodStartYear_(meta.anniversary, now);
      // The manual realized-seed counts only while it belongs to the current fee period (lazy reset).
      const seed = (String(meta.realizedSeedPeriod) === String(afYear)) ? (Number(meta.realizedSeed) || 0) : 0;
      cards[row.card] = {
        card: row.card, benefits: [],
        annualFee: meta.annualFee, anniversary: meta.anniversary,
        afYear: afYear, realized: seed, hasParseable: false, hasAnniversaryBenefit: false,
      };
      order.push(row.card);
    }
    const cardObj = cards[row.card];
    // Accumulate this benefit's realized value into its card's fee-period total. Only $-amount
    // benefits count, and only when the stored value belongs to the current period (lazy reset:
    // a stale RealizedPeriod reads as 0 — no cron).
    if (parseAmount_(row.amount) != null) cardObj.hasParseable = true;
    if (row.periodBasis === 'anniversary') cardObj.hasAnniversaryBenefit = true;
    if (String(row.realizedPeriod) === String(cardObj.afYear)) cardObj.realized += row.realizedValue;
    const done = isDone_(row, now);
    const snoozed = isSnoozed_(row, now);
    const endNum = periodEndDayNumber_(row.reset, now, row.periodBasis, row.anniversary);  // null = no expiry ('once')
    const daysLeft = (endNum === null) ? null : endNum - dayNumber_(now);  // sort key; days to period end
    // For a still-to-use benefit, how long until it resets (days left + expiry date). Skipped for
    // done/snoozed rows (those show their own status) and 'once' (no expiry).
    let expiryInfo = '';
    if (!done && !snoozed && endNum !== null) {
      expiryInfo = daysLeft <= 0 ? t_('expiryToday')
        : fmt_(t_('expiryInfo'), { n: daysLeft, date: fmtShortDate_(periodEndDate_(row.reset, now, row.periodBasis, row.anniversary)) });
    }
    // For a done benefit, when the credit refreshes (start of next period). Skipped for 'once'.
    let refreshInfo = '';
    if (done) {
      const refresh = periodRefreshDate_(row.reset, now, row.periodBasis, row.anniversary);
      if (refresh) refreshInfo = fmt_(t_('resetsOn'), { date: fmtShortDate_(refresh) });
    }
    cards[row.card].benefits.push({
      id: row.id, benefit: row.benefit, amount: row.amount, category: row.category,
      reset: row.reset, done: done, snoozed: snoozed, daysLeft: daysLeft,
      snoozeInfo: snoozed ? fmt_(t_('snoozedUntil'), { date: fmtShortDate_(row.snoozeUntil) }) : '',
      expiryInfo: expiryInfo,
      refreshInfo: refreshInfo,
      snoozeOptions: (!done && !snoozed) ? snoozeOptionsFor_(row.reset, now, row.periodBasis, row.anniversary) : [],
      snoozeMaxDate: (!done && !snoozed && endNum !== null) ? ymdFromDayNumber_(endNum) : '',  // date-picker cap
    });
  });
  return { cards: order.map(function (k) {
    const c = cards[k];
    // Show the realized-value bar only for cards with a fee AND at least one $-amount benefit
    // (a card with no parseable amounts could never move off 0). When shown without an anniversary,
    // accumulation falls back to the calendar year and we flag it so the UI can nudge the user.
    const showBar = c.annualFee > 0 && c.hasParseable;
    // Nudge to set the anniversary whenever it's missing AND it matters — the bar shows (its period
    // would fall back to the calendar year) or the card has an anniversary-basis benefit (whose
    // reset would be wrong). Independent of the bar so a no-fee anniversary card still gets nudged.
    return {
      card: c.card, benefits: c.benefits,
      annualFee: c.annualFee, realized: c.realized, showBar: showBar,
      feeResetInfo: showBar ? fmt_(t_('resetsOn'), { date: fmtShortDate_(annualFeeResetDate_(c.anniversary, now)) }) : '',
      anniversaryMissing: !c.anniversary && (showBar || c.hasAnniversaryBenefit),
    };
  }) };
}

function uiStrings_() {
  return {
    title: t_('dashTitle'), addCards: t_('addCards'),
    emptyTitle: t_('emptyTitle'), emptySub: t_('emptySub'),
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
    needSetup: t_('needSetup'), setAnniversary: t_('setAnniversary'),
  };
}

// Strings + option maps the Add-cards wizard (AddCards.html) renders entirely from.
function addUiStrings_() {
  return {
    title: t_('addTitle'),
    editTitle: t_('editCard'), editSubtitle: t_('editSubtitle'), editSubmit: t_('editSubmit'),
    savedTitle: t_('editSavedTitle'), labelUpdated: t_('editLabelUpdated'), labelAdded: t_('editLabelAdded'),
    labelRemoved: t_('editLabelRemoved'), keepEditing: t_('editKeepEditing'),
    cardLabel: t_('addCardLabel'), cardPlaceholder: t_('addCardPlaceholder'),
    cardOther: t_('addCardOther'), cardNamePlaceholder: t_('addCardNamePlaceholder'),
    verified: t_('addVerified'), source: t_('addSource'), reviewRecommended: t_('addReviewRecommended'),
    duplicateName: t_('addDuplicateName'),
    colBenefit: t_('addColBenefit'), colAmount: t_('addColAmount'),
    colCategory: t_('addColCategory'), colReset: t_('addColReset'),
    benefitNamePlaceholder: t_('addBenefitNamePlaceholder'), amountPlaceholder: t_('addAmountPlaceholder'),
    annualFeeLabel: t_('annualFeeLabel'), anniversaryLabel: t_('anniversaryLabel'), annualFeePlaceholder: t_('annualFeePlaceholder'),
    realizedSeedLabel: t_('realizedSeedLabel'), realizedSeedHelp: t_('realizedSeedHelp'),
    months: (CONFIG.LANG === 'zh')
      ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
      : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    addBenefit: t_('addAnotherBenefit'), submit: t_('addSubmit'), cancel: t_('confirmCancel'),
    selectAll: t_('addSelectAll'), clearAll: t_('addClearAll'), clearAllConfirm: t_('addClearAllConfirm'),
    pickCardFirst: t_('addPickCardFirst'), needCardName: t_('addNeedCardName'), needOne: t_('addNeedOne'), needName: t_('addNeedName'),
    needAnniversary: t_('addNeedAnniversary'),
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
  const url = webAppUrl_();
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;padding:40px;text-align:center;font-size:18px;color:#1a1a18;background:#faf9f5">' +
    esc_(msg) + '<br><br><a href="' + url + '" style="color:#185FA5;font-size:15px">' +
    esc_(t_('openDash')) + '</a></div>')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
