import { z } from 'zod'

export default defineMcpTool({
  name: 'task_list',
  description: 'Поиск задач (до 50) по правилам tasks.task.list: {"RESPONSIBLE_ID":5, "REAL_STATUS":[2,3], "%TITLE":"отчёт", "<DEADLINE":"2026-10-20"}; подзадачи — {"PARENT_ID":12}. Видны только задачи, доступные сотруднику.',
  annotations: READ_ONLY,
  inputSchema: {
    filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])).optional(),
    start: z.coerce.number().int().min(0).default(0).describe('Смещение (next прошлого ответа)'),
  },
  handler: async (args) => {
    const res = await b24Call('task_list', 'tasks.task.list', {
      filter: args.filter ?? {},
      order: { ID: 'DESC' },
      select: ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID', 'CREATED_BY', 'CREATED_DATE', 'CHANGED_DATE', 'GROUP_ID', 'PARENT_ID', 'UF_CRM_TASK'],
      start: args.start,
    }, args)
    // tasks.task.list отдаёт result = { tasks: [...] }
    return { tasks: res.result?.tasks ?? res.result, next: res.next ?? null, total: res.total }
  },
})
