// 來源：臺灣證券交易所市場開休市日期 https://www.twse.com.tw/zh/trading/holiday.html
/** @type {Record<string, {open:string[], closed:string[]}>} */
const publishedCalendars = {
  '2026': {
    open: ['01-02', '02-11', '02-23'],
    closed: [
      '01-01', '02-12', '02-13', '02-15', '02-16', '02-17', '02-18', '02-19', '02-20',
      '02-27', '02-28', '04-03', '04-04', '04-05', '04-06', '05-01', '06-19',
      '09-25', '09-28', '10-09', '10-10', '10-25', '10-26', '12-25'
    ]
  },
  '2027': {
    open: ['01-04', '02-01', '02-11'],
    closed: [
      '01-01', '02-02', '02-03', '02-04', '02-05', '02-06', '02-07', '02-08', '02-09', '02-10',
      '02-28', '03-01', '04-04', '04-05', '04-06', '04-30', '05-01', '06-09', '09-15',
      '09-28', '10-10', '10-11', '10-25', '12-24', '12-25', '12-31'
    ]
  }
};

const taipeiFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});

/** @param {Date} [instant] @returns {{date:string, hour:number, timestamp:string, iso:string}} */
export function taipeiClock(instant = new Date()) {
  const parts = Object.fromEntries(taipeiFormatter.formatToParts(instant).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}:${parts.second}`;
  const millis = String(instant.getUTCMilliseconds()).padStart(3, '0');
  return {
    date, hour: Number(parts.hour), timestamp: `${date} ${time}`,
    iso: `${date}T${time}.${millis}+08:00`
  };
}

/** @param {string} date @returns {boolean} */
export function validDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && shiftDate(date, 0) === date;
}

/** @param {string} date @param {number} days @returns {string} */
export function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** @param {string} date @returns {boolean} */
export function isWeekday(date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

/** @param {string} date @returns {boolean|null} */
export function isTradingDate(date) {
  const calendar = publishedCalendars[date.slice(0, 4)];
  if (!calendar) return null;
  const day = date.slice(5);
  if (calendar.open.includes(day)) return true;
  if (calendar.closed.includes(day)) return false;
  return isWeekday(date);
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

/** @param {string|number|Date} dateInput @returns {string} */
export function formatToSlashDate(dateInput) {
  if (typeof dateInput === 'string') {
    // 交易日及未標時區的台灣行情時間，直接保留其本地日期。
    const local = /^(\d{4}|\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.exec(dateInput.trim());
    if (local) return [local[1].padStart(4, '20'), local[2].padStart(2, '0'), local[3].padStart(2, '0')].join('/');
  }
  const instant = new Date(dateInput);
  const date = dateInput != null && Number.isFinite(instant.getTime())
    ? taipeiClock(instant).date
    : taipeiClock().date;
  return date.replaceAll('-', '/');
}

/** @param {string} slashDateStr @returns {string} */
export function getDateWithWeekday(slashDateStr) {
  const normalized = formatToSlashDate(slashDateStr);
  const dt = new Date(`${normalized.replace(/\//g, '-')}T00:00:00Z`);
  if (isNaN(dt.getTime())) return normalized;
  return `${normalized} (週${WEEKDAY_NAMES[dt.getUTCDay()]})`;
}
