// Ошибки здесь показываются человеку в браузере, а не уводят на непроверенный адрес клиента.
export default defineEventHandler(async (event) => {
  try {
    return sendRedirect(event, await useServices().oauth.authorize(getQuery(event)), 302)
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
