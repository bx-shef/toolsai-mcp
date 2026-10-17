import { z } from 'zod'

// Воронка для виджета funnel: стадии по порядку и сколько записей на каждой — одним batch
// (.bitrix-docs/b24-rest-docs/api-reference/how-to-call-rest-api/batch.md): crm.item.list по стадии,
// счёт — result_total, сами записи не нужны. Замер на тестовом портале 2026-10-17: result_total приходит.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД')

export default defineMcpTool({
  name: 'crm_funnel',
  description: 'Воронка: стадии по порядку и число сделок, лидов или элементов смарт-процесса на каждой (в работе, успех, провал). Можно ограничить датой создания и ответственным.',
  annotations: READ_ONLY,
  inputSchema: {
    entity: crmEntity,
    categoryId: z.coerce.number().int().min(0).optional().describe('Воронка; нет — основная (у смарт-процесса — воронка по умолчанию)'),
    createdFrom: day.optional(), createdTo: day.optional(),
    assignedById: z.coerce.number().int().positive().optional().describe('Только этого ответственного'),
  },
  handler: async (args) => {
    const etid = entityTypeId(args.entity)
    // Основная воронка: у сделок — 0, у смарт-процесса — своя (isDefault в crm.category.list), у лидов воронок нет
    let categoryId = args.categoryId ?? 0
    if (args.categoryId === undefined && etid > 4) {
      const cats = (await b24Call('crm_funnel', 'crm.category.list', { entityTypeId: etid }, args)).result?.categories ?? []
      categoryId = Number((cats.find((c: any) => c.isDefault === 'Y' || c.isDefault === true) ?? cats[0])?.id ?? 0)
    }
    const eid = stageEntityId(etid, categoryId)
    if (!eid) throw createError({ statusCode: 400, message: 'У контактов и компаний стадий нет' })
    const all = ((await b24Call('crm_funnel', 'crm.status.list', { filter: { ENTITY_ID: eid }, order: { SORT: 'ASC' } }, args)).result ?? []).map(stageOf)
    // batch — до 50 команд; больше 40 стадий в воронке не бывает на практике, но молча не режем
    const stages = all.slice(0, 40)
    if (!stages.length) return { categoryId, stages: [] }
    const filter: Record<string, unknown> = {}
    if (etid !== 1) filter.categoryId = categoryId
    if (args.createdFrom) filter['>=createdTime'] = `${args.createdFrom}T00:00:00`
    if (args.createdTo) filter['<=createdTime'] = `${args.createdTo}T23:59:59`
    if (args.assignedById) filter.assignedById = args.assignedById
    const cmd: Record<string, string> = {}
    stages.forEach((s: any, i: number) => {
      const q = new URLSearchParams({ entityTypeId: String(etid), 'select[]': 'id' })
      for (const [k, v] of Object.entries({ ...filter, stageId: s.id })) q.append(`filter[${k}]`, String(v))
      cmd[`s${i}`] = `crm.item.list?${q.toString()}`
    })
    const res = await b24Call('crm_funnel', 'batch', { halt: 0, cmd }, args)
    const totals = res.result?.result_total ?? {}
    const errors = res.result?.result_error ?? {}
    // Команда упала (лимит, нет доступа) — не «0 на стадии», а отказ: иначе виджет покажет выдуманную конверсию
    const failed = Object.keys(errors).filter(k => errors[k])
    if (failed.length) throw createError({ statusCode: 502, message: `Битрикс24 не посчитал стадии (${failed.length} из ${stages.length}) — повторите позже` })
    return {
      categoryId,
      stages: stages.map((s: any, i: number) => ({ ...s, count: Number(totals[`s${i}`] ?? 0) })),
      ...(all.length > stages.length ? { truncated: all.length - stages.length } : {}),
    }
  },
})
