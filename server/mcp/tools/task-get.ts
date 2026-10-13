import { z } from 'zod'

export default defineMcpTool({
  name: 'task_get',
  description: 'Задача по ID: описание, сроки, участники, привязки к CRM.',
  annotations: READ_ONLY,
  inputSchema: { id: z.number().int().positive() },
  handler: async ({ id }) => (await b24Call('task_get', 'tasks.task.get', { taskId: id }, { id })).result,
})
