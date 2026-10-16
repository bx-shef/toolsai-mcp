import { z } from 'zod'

export default defineMcpTool({
  name: 'note_get',
  description: 'Статья базы знаний целиком: заголовок и текст в Markdown, кто и когда изменил.',
  annotations: READ_ONLY,
  inputSchema: { id: z.coerce.number().int().positive() },
  handler: async ({ id }) => {
    const { result } = await b24Call('note_get', 'note.document.get', { id }, { id })
    const d = result?.item
    if (!d) throw createError({ statusCode: 404, message: 'Не найдено: статьи с таким ID нет или она недоступна сотруднику' })
    return { id: d.id, collectionId: d.collectionId, parentId: d.parentId, title: d.title, markdown: d.markdown, archived: Boolean(d.isArchived), updatedBy: d.updatedBy, updatedAt: d.updatedAt }
  },
})
