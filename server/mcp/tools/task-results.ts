import { z } from 'zod'

export default defineMcpTool({
  name: 'task_results',
  description: 'Результаты задачи: комментарии, которые отмечены как результат работы (автор, дата, текст).',
  annotations: READ_ONLY,
  inputSchema: { taskId: z.coerce.number().int().positive() },
  handler: async ({ taskId }) => (await b24Call('task_results', 'tasks.task.result.list', { taskId }, { taskId })).result,
})
