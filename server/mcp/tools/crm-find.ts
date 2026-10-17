import { z } from 'zod'

// crm.duplicate.findbycomm — .bitrix-docs/b24-rest-docs/api-reference/crm/duplicates/crm-duplicate-find-by-comm.md:
// до 20 значений; ответ {LEAD:[id], CONTACT:[id], COMPANY:[id]}; 20 и более совпадений по одному типу —
// остальные типы портал не возвращает.
const TYPES: Record<string, { etid: number, entity: string }> = { LEAD: { etid: 1, entity: 'lead' }, CONTACT: { etid: 3, entity: 'contact' }, COMPANY: { etid: 4, entity: 'company' } }

export default defineMcpTool({
  name: 'crm_find',
  description: 'Найти в CRM лиды, контакты и компании по телефону (в международном виде: +375…, «80…» портал не сопоставляет — замер 2026-10-17) или почте — кто звонил/писал, есть ли клиент, нет ли дублей. Возвращает найденные записи с названиями; карточка — crm_item_get. Сливать дубли — человеку в интерфейсе.',
  annotations: READ_ONLY,
  inputSchema: {
    phone: z.array(z.string().min(3).max(40)).max(20).optional(),
    email: z.array(z.string().email()).max(20).optional(),
  },
  handler: async (args) => {
    const found: Record<string, Set<number>> = {}
    for (const [type, values] of [['PHONE', args.phone], ['EMAIL', args.email]] as const) {
      if (!values?.length) continue
      const { result } = await b24Call('crm_find', 'crm.duplicate.findbycomm', { type, values }, args)
      for (const [k, ids] of Object.entries(result ?? {})) {
        if (!TYPES[k] || !Array.isArray(ids)) continue
        found[k] ??= new Set()
        for (const id of ids) found[k].add(Number(id))
      }
    }
    if (!args.phone?.length && !args.email?.length) throw createError({ statusCode: 400, message: 'Укажите phone или email' })
    const out = []
    for (const [k, ids] of Object.entries(found)) {
      const { etid, entity } = TYPES[k]!
      const list = (await b24Call('crm_find', 'crm.item.list', { entityTypeId: etid, filter: { '@id': [...ids] }, select: defaultSelect(etid) }, args)).result?.items ?? []
      out.push(...list.map((i: any) => ({ entity, id: i.id, title: i.title ?? [i.name, i.lastName].filter(Boolean).join(' '), assignedById: i.assignedById })))
      // Нет права читать — id без названия: запись есть, но сотруднику не видна
      for (const id of ids) if (!list.some((i: any) => Number(i.id) === id)) out.push({ entity, id, hidden: true })
    }
    return { found: out, duplicates: out.length > 1 }
  },
})
