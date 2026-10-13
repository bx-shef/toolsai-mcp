import { z } from 'zod'

const FIELDS = ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSED']

export default defineMcpTool({
  name: 'crm_deal_list',
  description: 'Поиск сделок CRM (до 50). Фильтр — по правилам crm.deal.list: {"STAGE_ID":"NEW", ">OPPORTUNITY":1000, "%TITLE":"окна", "ASSIGNED_BY_ID":5}. Видны только сделки, доступные сотруднику.',
  annotations: READ_ONLY,
  inputSchema: {
    filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).optional().describe('Фильтр crm.deal.list'),
    order: z.enum(['DATE_MODIFY', 'DATE_CREATE', 'OPPORTUNITY']).default('DATE_MODIFY').describe('Сортировка по убыванию'),
    start: z.number().int().min(0).default(0).describe('Смещение (из next прошлого ответа)'),
  },
  handler: async (args) => {
    const res = await b24Call('crm_deal_list', 'crm.deal.list', {
      filter: args.filter ?? {},
      order: { [args.order]: 'DESC' },
      select: FIELDS,
      start: args.start,
    }, args)
    return { deals: res }
  },
})
