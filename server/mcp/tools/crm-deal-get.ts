import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_deal_get',
  description: 'Карточка сделки CRM по ID со всеми полями, включая пользовательские (UF_*). Только если сотруднику доступна.',
  annotations: READ_ONLY,
  inputSchema: { id: z.number().int().positive().describe('ID') },
  handler: async ({ id }) => b24Call('crm_deal_get', 'crm.deal.get', { id }, { id }),
})
