function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null;
  return { year, month, day };
}

/** Date-only age shared by server projection and already-authorized profile views. */
export function ageOnCalendarDate(birthDate, today) {
  const birth = calendarDate(birthDate), now = calendarDate(today);
  if (!birth || !now || birthDate > today) return null;
  return now.year - birth.year - Number(now.month < birth.month || (now.month === birth.month && now.day < birth.day));
}
