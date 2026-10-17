import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_item_get',
  description: 'Карточка записи CRM — сделки, лида, контакта, компании или смарт-процесса — со всеми полями, включая пользовательские (ufCrm…). Только если сотруднику доступна. Названия полей — crm_fields.',
  annotations: READ_ONLY,
  inputSchema: { entity: crmEntity, id: z.coerce.number().int().positive() },
  handler: async ({ entity, id }) => {
    const { result } = await b24Call('crm_item_get', 'crm.item.get', { entityTypeId: entityTypeId(entity), id }, { entity, id })
    return result?.item ?? result
  },
})
