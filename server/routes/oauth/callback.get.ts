// Сюда возвращает портал (путь обработчика локального приложения).
export default defineEventHandler(async (event) => {
  try {
    return sendRedirect(event, await useServices().oauth.callback(getQuery(event)), 302)
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
