import { z } from 'zod'

/**
 * Привязка шаблона к сущности — строка (замер на тестовом портале 2026-10-17): сделки — 2_category_<воронка>,
 * смарт-процессы и счета — <тип>_<воронка>, лиды, контакты, компании — номер типа.
 */
export function templateBinding(etid: number, categoryId: number): string {
  if (etid === 2) return `2_category_${categoryId}`
  if (etid <= 4) return String(etid)
  return `${etid}_${categoryId}`
}

export default defineMcpTool({
  name: 'crm_doc_templates',
  description: 'Шаблоны документов (договор, счёт, акт, КП) для сущности CRM и воронки — чтобы создать документ через crm_doc_create.',
  annotations: READ_ONLY,
  inputSchema: { entity: crmEntity, categoryId: z.coerce.number().int().min(0).default(0).describe('Воронка сделки/смарт-процесса') },
  handler: async ({ entity, categoryId }) => {
    const binding = templateBinding(entityTypeId(entity), categoryId)
    // crm.documentgenerator.template.list — .bitrix-docs/b24-rest-docs/api-reference/crm/document-generator/templates/; result.templates — объект по id
    const { result } = await b24Call('crm_doc_templates', 'crm.documentgenerator.template.list', { select: ['id', 'name', 'region'], filter: { entityTypeId: binding, active: 'Y' } }, { entity, categoryId })
    return Object.values(result?.templates ?? {}).map((t: any) => ({ id: Number(t.id), name: t.name, region: t.region }))
  },
})
