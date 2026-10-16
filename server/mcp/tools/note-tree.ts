import { z } from 'zod'

/** Дерево без лишних полей: модели нужны id, заголовок и вложенность. */
const slim = (n: any): any => ({ id: n.id, title: n.title, ...(n.children?.length ? { children: n.children.map(slim) } : {}) })

export default defineMcpTool({
  name: 'note_tree',
  description: 'Оглавление базы знаний: статьи и вложенные страницы (id, заголовок). Архивные не показываются. ID базы — из note_bases.',
  annotations: READ_ONLY,
  inputSchema: { collectionId: z.coerce.number().int().positive() },
  handler: async ({ collectionId }) => {
    const { result } = await b24Call('note_tree', 'note.document.tree.list', { collectionId }, { collectionId })
    return { items: (result?.items ?? []).map(slim), truncated: Boolean(result?.truncated) }
  },
})
