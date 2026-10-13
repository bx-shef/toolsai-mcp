import { z } from 'zod'

export default defineMcpTool({
  name: 'task_get',
  description: 'Задача по ID: описание, сроки, участники, привязки к CRM.',
  annotations: READ_ONLY,
  inputSchema: { id: z.coerce.number().int().positive() },
  handler: async ({ id }) => {
    const { result } = await b24Call('task_get', 'tasks.task.get', { taskId: id }, { id })
    // Нет задачи или нет доступа — портал отвечает пустым массивом без ошибки (замер 2026-10-13).
    if (!result?.task) throw createError({ statusCode: 404, message: 'Не найдено: задачи с таким ID нет или она недоступна сотруднику' })
    return result.task
  },
})
