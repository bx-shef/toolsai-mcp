import { z } from 'zod'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД')
const TYPES: Record<string, string> = { 1: 'исходящий', 2: 'входящий', 3: 'входящий с перенаправлением', 4: 'обратный звонок', 5: 'информационный' }

// voximplant.statistic.get — .bitrix-docs/b24-rest-docs/api-reference/telephony/voximplant/voximplant-statistic-get.md.
// На тестовом портале звонков нет (2026-10-17) — форма по документации, проверить на портале с телефонией.
// Запись разговора (CALL_RECORD_URL) не отдаём: резюме и оценки — в делах (crm_activity_list).
export default defineMcpTool({
  name: 'calls_stats',
  description: 'Звонки телефонии за период (до 50 за раз): кто, тип, длительность, номер, исход (пропущен/успешен), привязка к CRM; и сводка по странице — сколько, сколько пропущено, сколько минут. Резюме и оценки звонков — crm_activity_list.',
  annotations: READ_ONLY,
  inputSchema: {
    from: day, to: day,
    userId: z.coerce.number().int().positive().optional().describe('Только звонки этого сотрудника'),
    type: z.enum(['outgoing', 'incoming']).optional(),
    start: z.coerce.number().int().min(0).default(0),
  },
  handler: async (args) => {
    const FILTER: Record<string, unknown> = { '>=CALL_START_DATE': `${args.from}T00:00:00`, '<=CALL_START_DATE': `${args.to}T23:59:59` }
    if (args.userId) FILTER.PORTAL_USER_ID = args.userId
    if (args.type) FILTER.CALL_TYPE = args.type === 'outgoing' ? 1 : [2, 3]
    const res = await b24Call('calls_stats', 'voximplant.statistic.get', { FILTER, SORT: 'CALL_START_DATE', ORDER: 'DESC', start: args.start }, args)
    const items = (Array.isArray(res.result) ? res.result : []).map((c: any) => ({
      id: c.CALL_ID,
      start: c.CALL_START_DATE,
      userId: Number(c.PORTAL_USER_ID),
      type: TYPES[String(c.CALL_TYPE)] ?? String(c.CALL_TYPE),
      phone: c.PHONE_NUMBER,
      durationSec: Number(c.CALL_DURATION),
      ok: String(c.CALL_FAILED_CODE) === '200',
      ...(String(c.CALL_FAILED_CODE) !== '200' ? { failed: c.CALL_FAILED_REASON || c.CALL_FAILED_CODE } : {}),
      ...(c.CRM_ENTITY_TYPE ? { crm: { type: c.CRM_ENTITY_TYPE, id: Number(c.CRM_ENTITY_ID) } } : {}),
    }))
    return {
      items,
      summary: { calls: items.length, missed: items.filter((c: any) => !c.ok).length, minutes: Math.round(items.reduce((s: number, c: any) => s + c.durationSec, 0) / 60) },
      next: res.next ?? null,
      total: res.total,
    }
  },
})
