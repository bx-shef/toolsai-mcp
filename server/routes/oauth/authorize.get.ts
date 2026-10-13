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
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(cfg.publicUrl).origin}; frame-ancestors 'none'`,
    })
    return consentPage(txn, clientName, redirectHost, `${cfg.publicUrl}/oauth/consent`)
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
