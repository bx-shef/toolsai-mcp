import { z } from 'zod'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД')

export default defineMcpTool({
  name: 'calendar_events',
  description: 'События календаря за период: свой календарь (по умолчанию), календарь сотрудника, группы или компании. Видны только события, доступные сотруднику.',
  annotations: READ_ONLY,
  inputSchema: {
    from: day.describe('Начало периода, ГГГГ-ММ-ДД'),
    to: day.describe('Конец периода, ГГГГ-ММ-ДД'),
    type: z.enum(['user', 'group', 'company_calendar']).default('user'),
    ownerId: z.coerce.number().int().min(0).optional().describe('ID сотрудника или группы; не задан — свой календарь; у календаря компании — 0'),
  },
  handler: async (args) => {
    const ownerId = args.ownerId ?? (args.type === 'company_calendar' ? 0 : (await b24Call('calendar_events', 'user.current', {}, {})).result.ID)
    const { result } = await b24Call('calendar_events', 'calendar.event.get', { type: args.type, ownerId: Number(ownerId), from: args.from, to: args.to }, args)
    return result
  },
})
