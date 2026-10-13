import { LOGIN_COOKIE } from '../../lib/oauth'

// Сюда возвращает портал (путь обработчика локального приложения).
export default defineEventHandler(async (event) => {
  try {
    const url = await useServices().oauth.callback(getQuery(event), getCookie(event, LOGIN_COOKIE))
    deleteCookie(event, LOGIN_COOKIE)
    return sendRedirect(event, url, 302)
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
