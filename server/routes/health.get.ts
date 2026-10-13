// Для скрипта выката: коммит образа и отвечает ли Redis.
export default defineEventHandler(async (event) => {
  const commit = process.env.COMMIT_SHA || 'dev'
  try {
    const { store } = useServices()
    await store.get('health:ping')
    return { status: 'ok', ready: true, commit }
  }
  catch (e) {
    setResponseStatus(event, 503)
    return { status: 'error', ready: false, commit, error: e instanceof Error ? e.message : 'unknown' }
  }
})
