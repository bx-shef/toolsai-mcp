import { z } from 'zod'
import { localTime } from '../../lib/people'

// Онлайн-запись (модуль booking): booking.v1.booking.list и booking.v1.resource.list —
// .bitrix-docs/b24-rest-docs/api-reference/booking/booking/booking-v1-booking-list.md,
// .../booking/resource/booking-v1-resource-list.md. Фильтр within — секунды unix. На тестовом
// портале записей нет (2026-10-17): поля брони — по документации booking.v1.booking.add, проверить
// на портале с записями; чего нет в ответе — не отдаём.
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата ГГГГ-ММ-ДД')

function stamp(v: any): number | null {
  const n = Number(v?.timestamp ?? v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export default defineMcpTool({
  name: 'booking_list',
  description: 'Записи на приём (онлайн-запись) за день или период: время, ресурс (специалист, кабинет), название, подтверждение и визит, если портал их отдаёт. Карточка записи на портале — /booking/detail/ID/.',
  annotations: READ_ONLY,
  inputSchema: {
    from: day, to: day.optional().describe('По какой день включительно; нет — только from'),
    timezoneOffsetMin: z.coerce.number().int().min(-720).max(840).default(180).describe('Смещение часового пояса портала в минутах (Минск, Москва — 180) — границы дня; время брони — в её собственном поясе'),
    resourceId: z.coerce.number().int().positive().optional(),
    withNote: z.boolean().default(false).describe('Отдать и описание брони (свободный текст: там бывают телефон, жалобы клиента)'),
    start: z.coerce.number().int().min(0).default(0),
  },
  handler: async (args) => {
    const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000 - args.timezoneOffsetMin * 60
    const filter: Record<string, unknown> = { within: { dateFrom: dayStart(args.from), dateTo: dayStart(args.to ?? args.from) + 86400 } }
    if (args.resourceId) filter.resourceId = [args.resourceId]
    const res = await b24Call('booking_list', 'booking.v1.booking.list', { filter, order: { id: 'ASC' }, start: args.start }, args)
    const list = res.result?.booking ?? []
    const resources = new Map<number, string>()
    const wanted = new Set<number>(list.flatMap((b: any) => (Array.isArray(b.resourceIds) ? b.resourceIds : []).map(Number)))
    // Ресурсы страницами по 50, пока не нашлись все нужные (не больше 5 страниц)
    for (let page = 0, start = 0; wanted.size && page < 5; page++) {
      const chunk = await b24Call('booking_list', 'booking.v1.resource.list', { start }, args)
      for (const r of chunk.result?.resource ?? []) { resources.set(Number(r.id), String(r.name ?? '')); wanted.delete(Number(r.id)) }
      if (chunk.next == null) break
      start = Number(chunk.next)
    }
    const items = list.map((b: any) => {
      const from = stamp(b.datePeriod?.from), to = stamp(b.datePeriod?.to)
      return {
        id: Number(b.id),
        name: b.name || '',
        ...(from ? { from: localTime(from, b.datePeriod?.from?.timezone, args.timezoneOffsetMin) } : {}),
        ...(to ? { to: localTime(to, b.datePeriod?.to?.timezone, args.timezoneOffsetMin) } : {}),
        resources: (Array.isArray(b.resourceIds) ? b.resourceIds : []).map((id: unknown) => resources.get(Number(id)) || `#${id}`),
        ...(typeof b.isConfirmed === 'boolean' ? { confirmed: b.isConfirmed } : {}),
        ...(typeof b.visitStatus === 'string' ? { visit: b.visitStatus } : {}),
        ...(args.withNote && b.description ? { note: String(b.description).slice(0, 300) } : {}),
      }
    })
    return { items, next: res.next ?? null }
  },
})
