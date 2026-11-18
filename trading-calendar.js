(function () {
  // 來源：臺灣證券交易所市場開休市日期 https://www.twse.com.tw/zh/trading/holiday.html
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

  function taipeiClock(instant = new Date()) {
    const parts = Object.fromEntries(taipeiFormatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}:${parts.second}`;
    const millis = String(instant.getUTCMilliseconds()).padStart(3, '0');
    return {
      date, hour: Number(parts.hour), timestamp: `${date} ${time}`,
      iso: `${date}T${time}.${millis}+08:00`
    };
  }

  function shiftDate(date, days) {
    const shifted = new Date(`${date}T00:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
  }

  function isWeekday(date) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5;
  }

  function isTradingDate(date) {
    const calendar = publishedCalendars[date.slice(0, 4)];
    if (!calendar) return null;
    const day = date.slice(5);
    if (calendar.open.includes(day)) return true;
    if (calendar.closed.includes(day)) return false;
    return isWeekday(date);
  }

  const calendar = { shiftDate, isWeekday, isTradingDate, taipeiClock };
  if (typeof module === 'object' && module.exports) {
    module.exports = calendar;
  } else {
    window.twseTradingCalendar = calendar;
  }
})();
