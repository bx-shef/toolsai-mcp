import { z } from 'zod'
import { daysToBirthday, monthDay } from '../../lib/people'

// user.get — .bitrix-docs/b24-rest-docs/api-reference/user/user-get.md. Фильтра по месяцу и дню у метода нет:
// читаем активных сотрудников страницами (до 10 страниц по 50) и считаем сами. Скрытая дата рождения
// приходит пустой — такой сотрудник просто не попадает в список.
export default defineMcpTool({
  name: 'staff_birthdays',
  description: 'Дни рождения сотрудников на ближайшие дни (и прошедшие за back дней): ID, имя, должность, дата, через сколько дней. Для поздравления (виджет birthday) — userId отсюда.',
  annotations: READ_ONLY,
  inputSchema: {
    days: z.coerce.number().int().min(0).max(60).default(7).describe('Сколько дней вперёд, 0 — только сегодня'),
    back: z.coerce.number().int().min(0).max(7).default(0).describe('Сколько прошедших дней тоже показать'),
  },
  handler: async (args) => {
    const today = new Date()
    const out: Array<Record<string, unknown>> = []
    let start = 0
    for (let page = 0; page < 10; page++) {
      const res = await b24Call('staff_birthdays', 'user.get', {
        FILTER: { ACTIVE: true, USER_TYPE: 'employee' },
        SELECT: ['ID', 'NAME', 'LAST_NAME', 'WORK_POSITION', 'PERSONAL_BIRTHDAY'],
        start,
      }, args)
      for (const u of Array.isArray(res.result) ? res.result : []) {
        const md = monthDay(u.PERSONAL_BIRTHDAY)
        if (!md) continue
        const inDays = daysToBirthday(md, today, args.back)
        if (inDays > args.days) continue
        out.push({ userId: Number(u.ID), name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' '), position: u.WORK_POSITION || '', date: `${String(md.day).padStart(2, '0')}.${String(md.month).padStart(2, '0')}`, inDays })
      }
      if (res.next == null) break
      start = Number(res.next)
    }
    out.sort((a, b) => Number(a.inDays) - Number(b.inDays))
    return { items: out }
  },
})
