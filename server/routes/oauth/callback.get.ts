import { ADMIN_STATE_PREFIX } from '../../lib/admin'
import { LOGIN_COOKIE } from '../../lib/oauth'

// Сюда возвращает портал (путь обработчика локального приложения): и вход сотрудника для
// MCP-клиента, и вход администратора на страницу настроек (state с приставкой adm.).
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  if (typeof q.state === 'string' && q.state.startsWith(ADMIN_STATE_PREFIX)) return adminCallback(event, q)
  try {
    const url = await useServices().oauth.callback(q, getCookie(event, LOGIN_COOKIE))
    clearLoginCookie(event)
    return sendRedirect(event, url, 302)
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
