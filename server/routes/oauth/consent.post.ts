import { LOGIN_COOKIE } from '../../lib/oauth'

// Решение с экрана согласия: разрешил — на вход в портал, отказал — клиенту с access_denied.
export default defineEventHandler(async (event) => {
  try {
    const body = await readParams(event)
    const url = await useServices().oauth.consent(body.txn, getCookie(event, LOGIN_COOKIE), body.decision === 'allow', body.portal)
    // Запомнить портал на этом браузере — в следующий раз поле уже заполнено.
    if (body.decision === 'allow' && typeof body.portal === 'string') setPortalCookie(event, body.portal)
    return sendRedirect(event, url, 303)
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
