/**
 * מענה אוטומטי להזמנת מנות — ימות המשיח + Google Apps Script
 *
 * doGet          — מקבל את השיחה משלוחת API בימות המשיח ומנהל את השאלות.
 * sendDailyReport — רץ פעם ביום ושולח לוואטסאפ (CallMeBot) ולמייל את רשימת ההזמנות.
 * setup          — מריצים פעם אחת: יוצר לשוניות בגיליון וטריגר יומי.
 *
 * מאפייני סקריפט (Project Settings > Script properties):
 *   CALLMEBOT_PHONE  — המספר שלך בפורמט בינלאומי, למשל 972501234567
 *   CALLMEBOT_APIKEY — המפתח שקיבלת מ-CallMeBot
 *   REPORT_EMAIL     — (רשות) מייל לגיבוי הסיכום
 */

// ---------- מענה לשיחה ----------

function doGet(e) {
  var params = (e && e.parameter) || {};
  var text;
  try {
    text = handleCall(params, appDeps());
  } catch (err) {
    console.error(err);
    text = say([t(CONFIG.TEXTS.error)]) + '&go_to_folder=hangup';
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT);
}

/**
 * לוגיקת השיחה. ימות המשיח שולחת בכל בקשה את כל המשתנים שנאספו עד כה,
 * לכן הפונקציה "חסרת מצב": בודקת מה כבר נענה ומחזירה את השאלה הבאה.
 */
function handleCall(p, deps) {
  if (p.hangup === 'yes') return '';

  if (!isActiveTime(deps.now())) {
    return say([t(CONFIG.TEXTS.closed)]) + '&go_to_folder=hangup';
  }

  var phone = normalizePhone(p.ApiPhone || '');
  var family = phone ? deps.findFamily(phone) : '';

  // שאלה 1: שם משפחה (רק למתקשר שלא מוכר)
  if (!family && !p.name_rec) {
    return 'read=' + t(CONFIG.TEXTS.askName) +
      '=name_rec,no,record,,,no,yes,,1,15';
  }

  // שאלה 2: מספר מנות
  if (p.portions === undefined || p.portions === '') {
    var intro = family ? t(CONFIG.TEXTS.greetingKnown) + '.' + t(family) + '.' : '';
    return 'read=' + intro + t(CONFIG.TEXTS.askPortions) +
      '=portions,no,2,1,10,Number,yes,no,,,3,,,';
  }

  var portions = parseInt(p.portions, 10);
  if (isNaN(portions) || portions < 0) {
    return say([t(CONFIG.TEXTS.error)]) + '&go_to_folder=hangup';
  }
  if (portions > CONFIG.MAX_PORTIONS) {
    return say([t(CONFIG.TEXTS.tooMany)]) + '&go_to_folder=hangup';
  }

  deps.saveOrder({
    phone: phone,
    family: family,
    portions: portions,
    recording: p.name_rec || '',
    callId: p.ApiCallId || ''
  });

  if (portions === 0) {
    return say([t(CONFIG.TEXTS.cancelled)]) + '&go_to_folder=hangup';
  }
  return say([t(CONFIG.TEXTS.savedBefore), 'n-' + portions, t(CONFIG.TEXTS.savedAfter)]) +
    '&go_to_folder=hangup';
}

function say(parts) {
  return 'id_list_message=' + parts.join('.');
}

/** טקסט להקראה, בלי התווים שימות המשיח לא מקבלת */
function t(text) {
  return 't-' + String(text).replace(/[.\-"'&|=,]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isActiveDay(date) {
  var day = Number(Utilities.formatDate(date, CONFIG.TIMEZONE, 'u')) % 7; // u: 1=שני..7=ראשון
  return CONFIG.ACTIVE_DAYS.indexOf(day) !== -1;
}

function isActiveTime(date) {
  var hm = Utilities.formatDate(date, CONFIG.TIMEZONE, 'HH:mm');
  return isActiveDay(date) && hm >= CONFIG.START_TIME && hm < CONFIG.END_TIME;
}

function normalizePhone(phone) {
  var d = String(phone).replace(/\D/g, '');
  if (d.indexOf('972') === 0) d = '0' + d.slice(3);
  return d;
}

// ---------- סיכום יומי ----------

function sendDailyReport() {
  var deps = appDeps();
  var now = deps.now();
  if (!isActiveDay(now)) return; // לא שולחים סיכום בימים שהמערכת סגורה (למשל שבת)
  var report = buildReport(deps.ordersOf(dayKey(now)), deps.familiesMap(), now);
  if (!report) return;
  deps.sendWhatsApp(report);
  deps.sendEmail('הזמנות ' + Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM'), report);
}

/**
 * בונה את הודעת הסיכום. הזמנה חוזרת מאותו טלפון באותו יום — האחרונה קובעת; אפס = ביטול.
 * orders: [{time, phone, family, portions, recording}] לפי סדר כרונולוגי.
 */
function buildReport(orders, families, now) {
  var byPhone = {};
  var order = [];
  orders.forEach(function (o) {
    var key = o.phone || ('?' + order.length);
    if (!(key in byPhone)) order.push(key);
    byPhone[key] = o;
  });

  var lines = [];
  var total = 0;
  order.forEach(function (key) {
    var o = byPhone[key];
    var portions = Number(o.portions);
    if (!portions) return;
    var name = families[o.phone] || o.family;
    if (!name) {
      name = 'לא מזוהה ' + (o.phone || 'מספר חסוי') + (o.recording ? ' (הקלטה: ' + o.recording + ')' : '');
    }
    lines.push(name + ' – ' + portions);
    total += portions;
  });

  var date = Utilities.formatDate(now, CONFIG.TIMEZONE, 'dd/MM');
  if (!lines.length) return 'הזמנות ' + date + ':\nאין הזמנות היום';
  return 'הזמנות ' + date + ':\n' + lines.join('\n') + '\nסה"כ: ' + total + ' מנות';
}

function dayKey(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

// ---------- חיבור לשירותי גוגל ----------

function appDeps() {
  var props = PropertiesService.getScriptProperties();
  return {
    now: function () { return new Date(); },

    findFamily: function (phone) {
      return familiesMap()[phone] || '';
    },

    familiesMap: familiesMap,

    saveOrder: function (o) {
      var lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        var sheet = getSheet(CONFIG.ORDERS_SHEET);
        var now = new Date();
        sheet.appendRow([
          dayKey(now),
          Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm:ss'),
          "'" + o.phone,
          o.family,
          o.portions,
          o.recording,
          o.callId
        ]);
      } finally {
        lock.releaseLock();
      }
    },

    ordersOf: function (day) {
      var values = getSheet(CONFIG.ORDERS_SHEET).getDataRange().getValues().slice(1);
      return values
        .filter(function (r) { return dayKeyOfCell(r[0]) === day; })
        .map(function (r) {
          return { time: r[1], phone: normalizePhone(r[2]), family: r[3], portions: r[4], recording: r[5] };
        });
    },

    sendWhatsApp: function (text) {
      var phone = props.getProperty('CALLMEBOT_PHONE');
      var key = props.getProperty('CALLMEBOT_APIKEY');
      if (!phone || !key) { console.warn('CallMeBot לא מוגדר'); return; }
      var url = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(phone) +
        '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(key);
      var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      console.log('CallMeBot: ' + res.getResponseCode());
    },

    sendEmail: function (subject, body) {
      var to = props.getProperty('REPORT_EMAIL');
      if (to) MailApp.sendEmail(to, subject, body);
    }
  };
}

function familiesMap() {
  var map = {};
  getSheet(CONFIG.FAMILIES_SHEET).getDataRange().getValues().slice(1).forEach(function (r) {
    var phone = normalizePhone(r[0]);
    if (phone && r[1]) map[phone] = String(r[1]).trim();
  });
  return map;
}

function dayKeyOfCell(v) {
  return v instanceof Date ? dayKey(v) : String(v);
}

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// ---------- הקמה (מריצים פעם אחת) ----------

function setup() {
  var orders = getSheet(CONFIG.ORDERS_SHEET);
  if (orders.getLastRow() === 0) {
    orders.appendRow(['תאריך', 'שעה', 'טלפון', 'משפחה', 'מנות', 'הקלטה', 'מזהה שיחה']);
  }
  var families = getSheet(CONFIG.FAMILIES_SHEET);
  if (families.getLastRow() === 0) {
    families.appendRow(['טלפון', 'שם משפחה']);
  }

  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'sendDailyReport') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('sendDailyReport').timeBased()
    .everyDays(1).atHour(CONFIG.REPORT_HOUR).inTimezone(CONFIG.TIMEZONE).create();
}

/** לבדיקה: שולח עכשיו את הסיכום של היום */
function testReportNow() {
  sendDailyReport();
}
