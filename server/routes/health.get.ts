// Для скрипта выката: коммит образа и отвечает ли Redis.
export default defineEventHandler(async (event) => {
  const commit = process.env.COMMIT_SHA || 'dev'
  try {
    const { store } = useServices()
    await store.get('health:ping')
    return { status: 'ok', ready: true, commit }
  }
  catch (e) {
    // /health виден снаружи через nginx — причину только в лог, не в ответ.
    console.error('[health]', e instanceof Error ? e.message : e)
    setResponseStatus(event, 503)
    return { status: 'error', ready: false, commit }
  }
})
