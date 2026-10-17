import { z } from 'zod'

// im.recent.list — .bitrix-docs/b24-rest-docs/api-reference/chats/im-recent-list.md; замер 2026-10-17:
// у личного диалога id — ID сотрудника, у чата — «chat<ID>»; это и есть dialogId для im_message_send.
export default defineMcpTool({
  name: 'im_chats',
  description: 'Недавние диалоги сотрудника: личные и групповые чаты (dialogId, тип, название) — чтобы выбрать, куда написать через im_message_send.',
  annotations: READ_ONLY,
  inputSchema: { limit: z.coerce.number().int().min(1).max(50).default(20) },
  handler: async ({ limit }) => {
    const { result } = await b24Call('im_chats', 'im.recent.list', { SKIP_OPENLINES: 'Y' }, { limit })
    return (result?.items ?? []).slice(0, limit).map((i: any) => ({ dialogId: String(i.id), type: i.type, title: i.title }))
  },
})
