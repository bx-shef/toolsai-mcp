import { z } from 'zod'

export default defineMcpTool({
  name: 'crm_item_list',
  description: 'Поиск записей CRM (до 50 за раз; ещё есть — next, передать в start). Фильтр по правилам crm.item.list, поля в camelCase: {"stageId":"NEW", ">opportunity":1000, "%title":"окна", "assignedById":5, "<updatedTime":"2026-10-01"}. Видны только записи, доступные сотруднику. В ответе словари users (ID → имя) и stages (код → название).',
  annotations: READ_ONLY,
  inputSchema: {
    entity: crmEntity,
    filter: crmFilter.optional(),
    select: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).max(50).optional().describe('Поля; не задано — короткая сводка'),
    order: z.enum(['updatedTime', 'createdTime', 'opportunity', 'id']).default('updatedTime').describe('Сортировка по убыванию'),
    start: z.coerce.number().int().min(0).default(0).describe('Смещение (next прошлого ответа)'),
  },
  handler: async (args) => {
    const etid = entityTypeId(args.entity)
    const res = await b24Call('crm_item_list', 'crm.item.list', {
      entityTypeId: etid,
      filter: args.filter ?? {},
      select: args.select ?? defaultSelect(etid),
      order: { [args.order]: 'DESC' },
      start: args.start,
    }, args)
    const items = (res.result?.items ?? []) as Record<string, unknown>[]
    // Словари имён: ответственный и стадия — то, о чём спрашивают первым делом
    const [users, stages] = await Promise.all([
      userNames('crm_item_list', items.flatMap(i => [i.assignedById, i.createdBy])),
      stageNames('crm_item_list', etid, items),
    ])
    return { items, users, stages, next: res.next ?? null, total: res.total }
  },
})
