import { z } from 'zod'

// catalog.* — .bitrix-docs/b24-rest-docs/api-reference/catalog/; замер 2026-10-17: catalog.product.list
// требует iblockId в фильтре, каталог CRM появляется на портале с первым товаром.
export default defineMcpTool({
  name: 'catalog_products',
  description: 'Товары каталога: поиск по названию (id, название, активен, количество). Каталоги — catalog_list; цены, остатки и описание — catalog_product_get.',
  annotations: READ_ONLY,
  inputSchema: {
    iblockId: z.coerce.number().int().positive().optional().describe('Каталог; не задан — первый (товарный каталог CRM)'),
    query: z.string().min(1).max(200).optional().describe('Часть названия'),
    start: z.coerce.number().int().min(0).default(0),
  },
  handler: async (args) => {
    const iblockId = args.iblockId ?? (await b24Call('catalog_products', 'catalog.catalog.list', {}, {})).result?.catalogs?.[0]?.iblockId
    if (!iblockId) return { items: [], next: null, total: 0, note: 'На портале нет каталога товаров' }
    const res = await b24Call('catalog_products', 'catalog.product.list', {
      select: ['id', 'iblockId', 'name', 'active', 'quantity'],
      filter: { iblockId, ...(args.query ? { '%name': args.query } : {}) },
      order: { id: 'desc' },
      start: args.start,
    }, args)
    return { items: res.result?.products ?? [], next: res.next ?? null, total: res.total }
  },
})
