import { PORTAL_COOKIE } from '../../utils/consent'

// Ошибки здесь показываются человеку в браузере, а не уводят на непроверенный адрес клиента.
export default defineEventHandler(async (event) => {
  try {
    const { cfg, oauth } = useServices()
    const { txn, clientName, redirectHost } = await oauth.authorize(getQuery(event))
    setLoginCookie(event, txn)
    setResponseHeaders(event, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', // согласие нельзя «нажать» из чужой рамки
      // form-action не ставим: Chrome применяет его ко всей цепочке редиректов после отправки формы
      // (портал → наш callback → redirect_uri клиента) и рвёт её на последнем шаге — вход в Claude не
      // завершается (найдено на живой коробке 2026-10-16). От встраивания держат frame-ancestors и X-Frame-Options.
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'`,
    })
    return consentPage(txn, clientName, redirectHost, `${cfg.publicUrl}/oauth/consent`, getCookie(event, PORTAL_COOKIE) || cfg.defaultPortal || '')
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
