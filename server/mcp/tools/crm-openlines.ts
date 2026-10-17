import { z } from 'zod'

// Обращения клиентов из открытых линий для виджета support: в CRM каждый диалог — дело с
// PROVIDER_ID = IMOPENLINES_SESSION (crm.activity.list, .bitrix-docs/b24-rest-docs/api-reference/crm/timeline/activities/
// activity-base/crm-activity-list.md). Незавершённое дело — диалог ещё не закрыт. Текст переписки не
// отдаём — только тему, канал, время и ответственного.
export default defineMcpTool({
  name: 'crm_openlines',
  description: 'Обращения клиентов из открытых линий (чаты, мессенджеры, виджет сайта): тема, код канала, клиент в CRM, ответственный (имя), когда начат и сколько минут открыт. Открытые — с самых давних; все — с новых. До 50.',
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
    const res = await b24Call('crm_openlines', 'crm.activity.list', {
      filter,
      // Открытые — с самых давних (кто дольше ждёт), все — с новых: иначе первая страница — история за годы
      order: { START_TIME: args.onlyOpen ? 'ASC' : 'DESC' },
      select: ['ID', 'SUBJECT', 'START_TIME', 'LAST_UPDATED', 'COMPLETED', 'RESPONSIBLE_ID', 'OWNER_TYPE_ID', 'OWNER_ID', 'PROVIDER_TYPE_ID'],
      start: args.start,
    }, args)
    const now = Date.now()
    const rows = Array.isArray(res.result) ? res.result : []
    const names = await userNames('crm_openlines', rows.map((a: any) => a.RESPONSIBLE_ID))
    const items = rows.map((a: any) => {
      const started = Date.parse(a.START_TIME)
      return {
        id: Number(a.ID),
        title: a.SUBJECT || 'Обращение',
        // Код коннектора открытой линии (telegrambot, livechat…), не название канала; на портале с диалогами не сверено
        connector: a.PROVIDER_TYPE_ID || '',
        open: a.COMPLETED !== 'Y',
        started: a.START_TIME,
        // Сколько диалог открыт (от начала), а не сколько клиент ждёт ответа: последней реплики в деле нет
        ...(Number.isFinite(started) && a.COMPLETED !== 'Y' ? { openMin: Math.max(0, Math.round((now - started) / 60000)) } : {}),
        responsibleId: Number(a.RESPONSIBLE_ID),
        ...(names[String(a.RESPONSIBLE_ID)] ? { responsible: names[String(a.RESPONSIBLE_ID)] } : {}),
        ...(Number(a.OWNER_ID) ? { crm: { entityTypeId: Number(a.OWNER_TYPE_ID), id: Number(a.OWNER_ID) } } : {}),
      }
    })
    return { items, next: res.next ?? null, total: res.total }
  },
})
