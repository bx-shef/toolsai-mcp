import { z } from 'zod'

// disk.folder.getchildren — замер 2026-10-17. DOWNLOAD_URL не отдаём: в нём токен доступа сотрудника,
// а ответ инструмента уходит к поставщику модели. Ссылка на просмотр — DETAIL_URL.
export default defineMcpTool({
  name: 'disk_folder',
  description: 'Содержимое папки Диска: папки и файлы (id, имя, тип, размер, кто и когда изменил, ссылка на просмотр). ID корня — из disk_storages.',
  annotations: READ_ONLY,
  inputSchema: { folderId: z.coerce.number().int().positive(), start: z.coerce.number().int().min(0).default(0) },
  handler: async (args) => {
    const res = await b24Call('disk_folder', 'disk.folder.getchildren', { id: args.folderId, start: args.start }, args)
    return {
      items: (res.result ?? []).map((x: any) => ({ id: Number(x.ID), name: x.NAME, type: x.TYPE, ...(x.SIZE ? { size: Number(x.SIZE) } : {}), updatedBy: Number(x.UPDATED_BY), updatedAt: x.UPDATE_TIME, url: x.DETAIL_URL })),
      next: res.next ?? null,
      total: res.total,
    }
  },
})
