export default defineEventHandler(async (event) => {
  try {
    const res = await useServices().oauth.register(await readBody(event))
    setResponseStatus(event, 201)
    return res
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
