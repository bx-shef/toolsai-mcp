import { z } from 'zod'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД')

export default defineMcpTool({
  name: 'calendar_busy',
  description: 'Занятость сотрудников за период (calendar.accessibility.get): когда заняты — чтобы найти общее свободное время для встречи.',
  annotations: READ_ONLY,
  inputSchema: {
    users: z.array(z.coerce.number().int().positive()).min(1).max(20),
    from: day,
    to: day,
  },
  handler: async (args) => (await b24Call('calendar_busy', 'calendar.accessibility.get', args, args)).result,
})
