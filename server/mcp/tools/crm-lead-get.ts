import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_lead_get',
  description: 'Карточка лида CRM по ID со всеми полями, включая пользовательские (UF_*). Только если сотруднику доступна.',
  annotations: READ_ONLY,
  inputSchema: { id: z.number().int().positive().describe('ID') },
  handler: async ({ id }) => (await b24Call('crm_lead_get', 'crm.lead.get', { id }, { id })).result,
})
