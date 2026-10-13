import { z } from 'zod'

const OWNER = { deal: 2, lead: 1, contact: 3, company: 4 } as const

export default defineMcpTool({
  name: 'crm_activity_list',
  description: 'Дела (звонки, письма, встречи, задачи CRM) по сделке, лиду, контакту или компании, новые сначала, до 50. В DESCRIPTION звонка — резюме и оценка ИИ, если есть.',
  annotations: READ_ONLY,
  inputSchema: {
    ownerType: z.enum(['deal', 'lead', 'contact', 'company']),
    ownerId: z.number().int().positive(),
    onlyCalls: z.boolean().default(false).describe('Только звонки'),
    start: z.number().int().min(0).default(0),
  },
  handler: async (args) => {
    const filter: Record<string, unknown> = { OWNER_TYPE_ID: OWNER[args.ownerType], OWNER_ID: args.ownerId }
    if (args.onlyCalls) filter.TYPE_ID = 2
    return { activities: await b24Call('crm_activity_list', 'crm.activity.list', {
      filter,
      order: { ID: 'DESC' },
      select: ['ID', 'TYPE_ID', 'PROVIDER_ID', 'DIRECTION', 'SUBJECT', 'DESCRIPTION', 'START_TIME', 'END_TIME', 'DEADLINE', 'COMPLETED', 'RESPONSIBLE_ID'],
      start: args.start,
    }, args) }
  },
})
