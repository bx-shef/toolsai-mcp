import { z } from 'zod'

export default defineMcpTool({
  name: 'task_elapsed',
  description: 'Учёт времени по задаче: записи о затраченном времени (кто, сколько секунд, когда, комментарий) — до 50 за запрос.',
  annotations: READ_ONLY,
  inputSchema: {
    taskId: z.coerce.number().int().positive(),
    userId: z.coerce.number().int().positive().optional().describe('Только записи этого сотрудника'),
  },
  handler: async (args) => {
    const res = await b24Call('task_elapsed', 'task.elapseditem.getlist', {
      taskId: args.taskId,
      order: { ID: 'asc' },
      filter: args.userId ? { USER_ID: args.userId } : {},
    }, args)
    const items = Array.isArray(res.result) ? res.result : []
    return { items, totalSeconds: items.reduce((s: number, i: any) => s + Number(i.SECONDS || 0), 0), total: res.total }
  },
})
