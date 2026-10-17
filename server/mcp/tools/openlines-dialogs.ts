import { z } from 'zod'

// Обращения клиентов из открытых линий для виджета support: в CRM каждый диалог — дело с
// PROVIDER_ID = IMOPENLINES_SESSION (crm.activity.list, .bitrix-docs/b24-rest-docs/api-reference/crm/timeline/activities/
// activity-base/crm-activity-list.md). Незавершённое дело — диалог ещё не закрыт. Текст переписки не
// отдаём — только тему, канал, время и ответственного.
export default defineMcpTool({
  name: 'openlines_dialogs',
  description: 'Обращения клиентов из открытых линий (чаты, мессенджеры, виджет сайта): открытые сначала, тема, клиент в CRM, ответственный, когда начато и сколько ждёт. До 50.',
  annotations: READ_ONLY,
  inputSchema: {
    onlyOpen: z.boolean().default(true).describe('Только незакрытые диалоги'),
    responsibleId: z.coerce.number().int().positive().optional(),
    start: z.coerce.number().int().min(0).default(0),
  },
  handler: async (args) => {
    const filter: Record<string, unknown> = { PROVIDER_ID: 'IMOPENLINES_SESSION' }
    if (args.onlyOpen) filter.COMPLETED = 'N'
    if (args.responsibleId) filter.RESPONSIBLE_ID = args.responsibleId
    const res = await b24Call('openlines_dialogs', 'crm.activity.list', {
      filter,
      order: { START_TIME: 'ASC' },
      select: ['ID', 'SUBJECT', 'START_TIME', 'LAST_UPDATED', 'COMPLETED', 'RESPONSIBLE_ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'PROVIDER_TYPE_ID'],
      start: args.start,
    }, args)
    const now = Date.now()
    const items = (Array.isArray(res.result) ? res.result : []).map((a: any) => {
      const started = Date.parse(a.START_TIME)
      return {
        id: Number(a.ID),
        title: a.SUBJECT || 'Обращение',
        channel: a.PROVIDER_TYPE_ID || '',
        open: a.COMPLETED !== 'Y',
        started: a.START_TIME,
        ...(Number.isFinite(started) && a.COMPLETED !== 'Y' ? { waitingMin: Math.max(0, Math.round((now - started) / 60000)) } : {}),
        responsibleId: Number(a.RESPONSIBLE_ID),
        ...(Number(a.OWNER_ID) ? { crm: { entityTypeId: Number(a.OWNER_TYPE_ID), id: Number(a.OWNER_ID) } } : {}),
      }
    })
    return { items, next: res.next ?? null, total: res.total }
  },
})
