import { landingPage } from '../lib/landing'

// Посадочная: открытая, без данных и скриптов; встраивается в слайдер портала, как /connect.
export default defineEventHandler((event) => {
  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors *`,
  })
  return landingPage(useServices().cfg.publicUrl)
})
