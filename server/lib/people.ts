/**
 * Дни рождения сотрудников (инструмент staff_birthdays): чистая логика без Nuxt, тест — tests/lib.test.ts.
 * PERSONAL_BIRTHDAY у user.get — строка даты в формате портала («1990-10-19T03:00:00+03:00» или
 * пусто, замер на тестовом портале 2026-10-17); берём только месяц и день.
 */

/** Месяц и день из PERSONAL_BIRTHDAY; пусто или мусор — null. */
export function monthDay(value: unknown): { month: number, day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''))
  if (!m) return null
  const month = Number(m[2]), day = Number(m[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null
}

/**
 * Через сколько дней ближайший день рождения от $today (0 — сегодня, отрицательное — был N дней
 * назад, если это ближе $back дней). 29 февраля в невисокосный год — 28-е.
 */
export function daysToBirthday(md: { month: number, day: number }, today: Date, back = 0): number {
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  let best = Number.POSITIVE_INFINITY
  for (const y of [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
    const day = md.month === 2 && md.day === 29 && !leap ? 28 : md.day
    const diff = Math.round((Date.UTC(y, md.month - 1, day) - base) / 86400000)
    if (diff >= -back && diff < best) best = diff
  }
  return best
}

/** Время брони «ГГГГ-ММ-ДД ЧЧ:ММ» в часовом поясе самой брони (datePeriod.*.timezone); нет пояса — по смещению. */
export function localTime(ts: number, timezone: unknown, offsetMin: number): string {
  if (typeof timezone === 'string' && timezone) {
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts * 1000)).map(p => [p.type, p.value]))
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
    }
    catch { /* неизвестный пояс — по смещению */ }
  }
  return new Date((ts + offsetMin * 60) * 1000).toISOString().slice(0, 16).replace('T', ' ')
}
