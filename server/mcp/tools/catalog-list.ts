export default defineMcpTool({
  name: 'catalog_list',
  description: 'Каталоги товаров портала (iblockId, название) — для catalog_products.',
  annotations: READ_ONLY,
  inputSchema: {},
  handler: async () => ((await b24Call('catalog_list', 'catalog.catalog.list', {})).result?.catalogs ?? [])
    .map((c: any) => ({ iblockId: c.iblockId, name: c.name, offers: Boolean(c.productIblockId) })),
})
