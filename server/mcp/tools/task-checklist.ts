import { z } from 'zod'

export default defineMcpTool({
  name: 'task_checklist',
  description: 'Чек-листы задачи: пункты, отмечены ли, кто и когда отметил. Пункт с PARENT_ID 0 — заголовок чек-листа.',
  annotations: READ_ONLY,
  inputSchema: { taskId: z.coerce.number().int().positive() },
  handler: async ({ taskId }) => (await b24Call('task_checklist', 'task.checklistitem.getlist', { TASKID: taskId }, { taskId })).result,
})
