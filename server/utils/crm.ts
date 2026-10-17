import { z } from 'zod'

// Сущности CRM через crm.item.* — замена DEPRECATED crm.deal/lead/contact/company.*
// (.bitrix-docs/b24-rest-docs/api-reference/crm/deals/crm-deal-get.md → crm/universal/crm-item-get.md).

const TYPES = { lead: 1, deal: 2, contact: 3, company: 4 } as const

/** Сущность: deal / lead / contact / company или ID типа смарт-процесса (из crm_stages / настроек CRM). */
export const crmEntity = z.union([z.enum(['deal', 'lead', 'contact', 'company']), z.coerce.number().int().positive()])
  .describe('deal, lead, contact, company или ID типа смарт-процесса')

export function entityTypeId(e: z.infer<typeof crmEntity>): number {
  return typeof e === 'number' ? e : TYPES[e]
}

/** Колонки списка по умолчанию — короткая сводка; полная карточка — crm_item_get. */
export function defaultSelect(etid: number): string[] {
  if (etid === 3) return ['id', 'name', 'lastName', 'post', 'companyId', 'assignedById', 'updatedTime']
  if (etid === 4) return ['id', 'title', 'assignedById', 'updatedTime']
  return ['id', 'title', 'stageId', 'categoryId', 'opportunity', 'currencyId', 'assignedById', 'contactId', 'companyId', 'updatedTime']
}

/**
 * ENTITY_ID стадий для crm.status.list (замер на тестовом портале 2026-10-17): сделки общей воронки —
 * DEAL_STAGE, другой — DEAL_STAGE_<воронка>; лиды — STATUS; смарт-процессы и счета —
 * DYNAMIC_<тип>_STAGE_<воронка>.
 */
export function stageEntityId(etid: number, categoryId: number): string | null {
  if (etid === 1) return 'STATUS'
  if (etid === 2) return categoryId ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE'
  if (etid === 3 || etid === 4) return null
  return `DYNAMIC_${etid}_STAGE_${categoryId}`
}

/** Стадия из crm.status.list: ID, название, смысл (process / success / failure) — общая для crm_stages и crm_funnel. */
export function stageOf(s: any): { id: string, name: string, semantics: string } {
  return { id: String(s.STATUS_ID), name: s.NAME, semantics: s.EXTRA?.SEMANTICS ?? (s.SEMANTICS === 'S' ? 'success' : s.SEMANTICS === 'F' ? 'failure' : 'process') }
}

export const crmFilter = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
