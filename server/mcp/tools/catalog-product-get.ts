import { z } from 'zod'

export default defineMcpTool({
  name: 'catalog_product_get',
  description: 'Товар целиком: название, описания, активность, цены по типам цен, остатки по складам.',
  annotations: READ_ONLY,
  inputSchema: { id: z.coerce.number().int().positive() },
  handler: async ({ id }) => {
    const p = (await b24Call('catalog_product_get', 'catalog.product.get', { id }, { id })).result?.product
    if (!p) throw createError({ statusCode: 404, message: 'Не найдено: товара с таким ID нет' })
    const prices = (await b24Call('catalog_product_get', 'catalog.price.list', { filter: { productId: id } }, { id })).result?.prices ?? []
    const stores = (await b24Call('catalog_product_get', 'catalog.storeproduct.list', { filter: { productId: id } }, { id })).result?.storeProducts ?? []
    return {
      id: p.id, iblockId: p.iblockId, name: p.name, active: p.active, quantity: p.quantity,
      previewText: p.previewText ?? null, detailText: p.detailText ?? null,
      prices: prices.map((x: any) => ({ priceTypeId: x.catalogGroupId, price: x.price, currency: x.currency })),
      stores: stores.map((x: any) => ({ storeId: x.storeId, amount: x.amount, reserved: x.quantityReserved })),
    }
  },
})
