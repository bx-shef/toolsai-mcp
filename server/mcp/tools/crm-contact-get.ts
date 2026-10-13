import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_contact_get',
  description: 'Карточка контакта CRM по ID со всеми полями, включая пользовательские (UF_*). Только если сотруднику доступна.',
  annotations: READ_ONLY,
  inputSchema: { id: z.number().int().positive().describe('ID') },
  handler: async ({ id }) => (await b24Call('crm_contact_get', 'crm.contact.get', { id }, { id })).result,
})
