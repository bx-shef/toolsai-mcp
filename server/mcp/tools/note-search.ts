import { z } from 'zod'

export default defineMcpTool({
  name: 'note_search',
  description: 'Поиск статей во всех доступных базах знаний по заголовку и тексту: id, заголовок, фрагмент с совпадением. Полный текст — note_get.',
  annotations: READ_ONLY,
  inputSchema: {
    query: z.string().min(3).max(200).describe('Что искать, от 3 символов'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  },
  handler: async (args) => {
    const { result } = await b24Call('note_search', 'note.document.search.list', { query: args.query, pagination: { limit: args.limit } }, args)
    return {
      items: (result?.items ?? []).map((d: any) => ({
        id: d.documentId,
        collectionId: d.collectionId,
        title: d.title,
        // <mark> портала — разметка для экрана; модели хватит текста
        snippet: String(d.snippet ?? '').replace(/<\/?mark>/g, ''),
      })),
      hasMore: Boolean(result?.hasMore),
    }
  },
})
