// בדיקות מקומיות ללוגיקה: node menot-auto/test/run-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// תחליף ל-Utilities.formatDate של גוגל (רק התבניות שבשימוש)
const Utilities = {
  formatDate(date, tz, fmt) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(date).map(p => [p.type, p.value]));
    const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
    return fmt
      .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
      .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second)
      .replace('u', String(u));
  }
};

const ctx = vm.createContext({ Utilities, console });
for (const f of ['config.gs', 'Code.gs']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
}
const { handleCall, buildReport, normalizePhone, t } = ctx;

// יום שלישי 24/11/2026 10:00 שעון ישראל = 08:00 UTC
const OPEN = new Date('2026-11-24T08:00:00Z');
const LATE = new Date('2026-11-24T12:30:00Z'); // 14:30
const SHABBAT = new Date('2026-11-28T08:00:00Z');

function deps(now, families = {}) {
  const saved = [];
  return {
    saved,
    now: () => now,
    findFamily: (p) => families[p] || '',
    saveOrder: (o) => saved.push(o)
  };
}

let n = 0;
function test(name, fn) { fn(); n++; console.log('✓', name); }

test('מחוץ לשעות — הודעה וניתוק', () => {
  const r = handleCall({ ApiPhone: '0501234567' }, deps(LATE));
  assert.match(r, /^id_list_message=t-.*&go_to_folder=hangup$/);
});

test('שבת — סגור', () => {
  assert.match(handleCall({ ApiPhone: '0501234567' }, deps(SHABBAT)), /go_to_folder=hangup/);
});

test('מתקשר חדש — מבקשים הקלטת שם', () => {
  const r = handleCall({ ApiPhone: '0501234567' }, deps(OPEN));
  assert.match(r, /^read=t-[^=]+=name_rec,no,record,/);
});

test('אחרי הקלטה — שואלים מנות', () => {
  const r = handleCall({ ApiPhone: '0501234567', name_rec: '/1/000.wav' }, deps(OPEN));
  assert.match(r, /^read=t-[^=]+=portions,no,2,1,10,Number,/);
});

test('מתקשר מוכר — ברכה בשם ומדלגים על השם', () => {
  const r = handleCall({ ApiPhone: '972501234567' }, deps(OPEN, { '0501234567': 'כהן' }));
  assert.match(r, /^read=t-שלום משפחת\.t-כהן\.t-/);
  assert.match(r, /=portions,/);
});

test('שמירת הזמנה ואישור', () => {
  const d = deps(OPEN, { '0501234567': 'כהן' });
  const r = handleCall({ ApiPhone: '0501234567', portions: '4', ApiCallId: 'abc' }, d);
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0].portions, 4);
  assert.equal(d.saved[0].family, 'כהן');
  assert.match(r, /\.n-4\./);
  assert.match(r, /go_to_folder=hangup$/);
});

test('אפס = ביטול', () => {
  const d = deps(OPEN);
  const r = handleCall({ ApiPhone: '0501234567', name_rec: 'x', portions: '0' }, d);
  assert.equal(d.saved[0].portions, 0);
  assert.match(r, /בוטלה/);
});

test('יותר מדי מנות — לא נשמר', () => {
  const d = deps(OPEN);
  handleCall({ ApiPhone: '0501234567', name_rec: 'x', portions: '99' }, d);
  assert.equal(d.saved.length, 0);
});

test('בקשת ניתוק — תשובה ריקה', () => {
  assert.equal(handleCall({ hangup: 'yes', portions: '3' }, deps(OPEN)), '');
});

test('טקסט להקראה בלי תווים אסורים', () => {
  assert.equal(t('סה"כ 3.5 - בדיקה'), 't-סה כ 3 5 בדיקה');
});

test('נרמול טלפון', () => {
  assert.equal(normalizePhone('+972-50-123-4567'), '0501234567');
  assert.equal(normalizePhone('050-1234567'), '0501234567');
});

test('סיכום: האחרונה קובעת, ביטול נעלם, לא מזוהה עם הקלטה', () => {
  const report = buildReport([
    { phone: '0501111111', family: '', portions: 3 },
    { phone: '0502222222', family: '', portions: 6 },
    { phone: '0501111111', family: '', portions: 4 },
    { phone: '0503333333', family: '', portions: 2 },
    { phone: '0503333333', family: '', portions: 0 },
    { phone: '0504444444', family: '', portions: 5, recording: '/1/007.wav' }
  ], { '0501111111': 'כהן', '0502222222': 'לוי' }, OPEN);
  assert.equal(report,
    'הזמנות 24/11:\nכהן – 4\nלוי – 6\nלא מזוהה 0504444444 (הקלטה: /1/007.wav) – 5\nסה"כ: 15 מנות');
});

test('סיכום ריק', () => {
  assert.equal(buildReport([], {}, OPEN), 'הזמנות 24/11:\nאין הזמנות היום');
});

console.log(`\n${n} בדיקות עברו`);
