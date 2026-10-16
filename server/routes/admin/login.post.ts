// Начать вход администратора: на страницу входа портала, возврат — /oauth/callback (state adm.…).
export default defineEventHandler(async (event) => {
  const body = await readParams(event)
  try {
    const { state, url } = await useServices().admin.start(body.portal)
    setAdminLoginCookie(event, state)
    if (typeof body.portal === 'string') setPortalCookie(event, body.portal)
    return sendRedirect(event, url, 303)
  }
  catch (e) {
    adminHeaders(event)
    setResponseStatus(event, 400)
    return adminLoginPage(typeof body.portal === 'string' ? body.portal : '', e instanceof Error ? e.message : 'Ошибка')
  }
})
