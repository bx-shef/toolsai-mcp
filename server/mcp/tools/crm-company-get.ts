import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_company_get',
  description: 'Карточка компании CRM по ID со всеми полями, включая пользовательские (UF_*). Только если сотруднику доступна.',
  annotations: READ_ONLY,
  inputSchema: { id: z.number().int().positive().describe('ID') },
  handler: async ({ id }) => b24Call('crm_company_get', 'crm.company.get', { id }, { id }),
})
