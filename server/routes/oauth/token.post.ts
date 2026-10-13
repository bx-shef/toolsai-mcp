export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
  try {
    const res = await useServices().oauth.token(await readParams(event))
    setResponseHeader(event, 'Cache-Control', 'no-store')
    return res
  }
  catch (e) {
    return oauthFail(event, e)
  }
})
