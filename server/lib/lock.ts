// Блокировка по ключу внутри процесса. Сервер — один контейнер с одним процессом Node
// (docker-compose.yml), этого хватает для одноразовых кодов и refresh токенов.
// Второй процесс потребует блокировок в Redis.

const tails = new Map<string, Promise<unknown>>()

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  tails.set(key, run)
  try {
    return await run
  }
  finally {
    if (tails.get(key) === run) tails.delete(key)
  }
}
