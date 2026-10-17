import { connectPage } from '../lib/connect'

// Открытая страница без данных и действий: её показывает «Вид «ИИ»» модуля shef.toolsai в слайдере портала —
// поэтому встраивание разрешено (frame-ancestors *), а скриптов нет вовсе.
export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *`,
  })
  return connectPage(useServices().cfg.publicUrl)
})
