import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_stages',
  description: 'Воронки и стадии сущности CRM: ID стадии, название, смысл (process — в работе, success — успех, failure — провал). Нужно, чтобы читать stageId и переводить по стадиям.',
  annotations: READ_ONLY,
  inputSchema: { entity: crmEntity, categoryId: z.coerce.number().int().min(0).optional().describe('Воронка; не задано — все') },
  handler: async ({ entity, categoryId }) => {
    const etid = entityTypeId(entity)
    // У лидов воронок нет; у контактов и компаний нет стадий
    const cats = etid === 1
      ? [{ id: 0, name: 'Лиды' }]
      : ((await b24Call('crm_stages', 'crm.category.list', { entityTypeId: etid }, { entity })).result?.categories ?? []).map((c: any) => ({ id: Number(c.id), name: c.name }))
    const out = []
    for (const c of cats) {
      if (categoryId !== undefined && c.id !== categoryId) continue
      const eid = stageEntityId(etid, c.id)
      const stages = eid
        ? ((await b24Call('crm_stages', 'crm.status.list', { filter: { ENTITY_ID: eid }, order: { SORT: 'ASC' } }, { entity })).result ?? [])
            .map((s: any) => ({ id: s.STATUS_ID, name: s.NAME, semantics: s.EXTRA?.SEMANTICS ?? (s.SEMANTICS === 'S' ? 'success' : s.SEMANTICS === 'F' ? 'failure' : 'process') }))
        : []
      out.push({ categoryId: c.id, name: c.name, stages })
    }
    return out
  },
})
