// timeman.status — .bitrix-docs/b24-rest-docs/api-reference/timeman/base/timeman-status.md; замер 2026-10-17
export default defineMcpTool({
  name: 'worktime_status',
  description: 'Рабочий день сотрудника: начат (OPENED), на паузе (PAUSED), закончен (CLOSED), время начала и конца, длительность. Управление — worktime_action.',
  annotations: READ_ONLY,
  inputSchema: {},
  handler: async () => {
    const r = (await b24Call('worktime_status', 'timeman.status', {})).result ?? {}
    return { status: r.STATUS, start: r.TIME_START ?? null, finish: r.TIME_FINISH ?? null, duration: r.DURATION ?? null, leaks: r.TIME_LEAKS ?? null }
  },
})
