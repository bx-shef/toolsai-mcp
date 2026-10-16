import { z } from 'zod'

// Где комментарии, зависит от задачи (замер 2026-10-16 на облаке): у новых задач — чат задачи
// (chatId, читается im.dialog.messages.get, нужно право im), у старых — форум (task.commentitem.getlist).
export default defineMcpTool({
  name: 'task_comments',
  description: 'Комментарии задачи (до 50 последних): автор, дата, текст. Для анализа обсуждения и того, что сделано.',
  annotations: READ_ONLY,
  inputSchema: { taskId: z.coerce.number().int().positive() },
  handler: async ({ taskId }) => {
    const { result } = await b24Call('task_comments', 'tasks.task.get', { taskId, select: ['ID', 'CHAT_ID', 'FORUM_TOPIC_ID'] }, { taskId })
    const task = result?.task
    if (!task) throw createError({ statusCode: 404, message: 'Не найдено: задачи с таким ID нет или она недоступна сотруднику' })
    if (Number(task.chatId) > 0) {
      const { result: chat } = await b24Call('task_comments', 'im.dialog.messages.get', { DIALOG_ID: `chat${task.chatId}`, LIMIT: 50 }, { taskId })
      // Служебные сообщения (author_id 0: «создал задачу», смена статуса) — тоже история задачи, но помечаем.
      return {
        source: 'chat',
        messages: (chat?.messages ?? []).map((m: any) => ({ id: m.id, authorId: m.author_id, system: !m.author_id, date: m.date, text: m.text })),
      }
    }
    const { result: items } = await b24Call('task_comments', 'task.commentitem.getlist', { TASKID: taskId, ORDER: { POST_DATE: 'desc' } }, { taskId })
    return { source: 'forum', messages: (items ?? []).slice(0, 50).map((c: any) => ({ id: c.ID, authorId: Number(c.AUTHOR_ID), date: c.POST_DATE, text: c.POST_MESSAGE })) }
  },
})
