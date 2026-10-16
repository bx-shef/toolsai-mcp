import { loadIcon } from '../lib/icon'

// GET и HEAD /icon (HEAD — для проверок вроде curl -I) — иконка коннектора (своя из каталога branding или встроенная). Читается на каждый
// запрос: заменили файл — новая иконка без перезапуска (клиенты сами кешируют её при подключении).
export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') {
    setResponseHeader(event, 'Allow', 'GET, HEAD')
    throw createError({ statusCode: 405 })
  }
  const icon = await loadIcon(process.env.BRANDING_DIR || '/branding')
  setResponseHeaders(event, {
    'Content-Type': icon.type,
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    // SVG из каталога — чужой файл: без скриптов и внешних ресурсов
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
  return icon.body
})
