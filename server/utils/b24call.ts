import { audit } from '../lib/audit'
import { B24Error, ReloginRequired } from '../lib/b24'
import type { Session } from '../lib/oauth'

/**
 * REST из инструмента от имени сотрудника, подключившего клиента.
 * Кто вызывает — из Bearer-токена (middleware 00.auth.ts), никогда не из аргументов инструмента.
 */
export async function b24Call(tool: string, method: string, params: Record<string, unknown>, args: object = {}) {
  const session = useEvent().context.session as Session | undefined
  if (!session) throw createError({ statusCode: 401, message: 'Нет сессии' })
  const started = Date.now()
  try {
    const res = await useServices().b24.call(session.userId, method, params)
    audit({ user: session.userId, tool, method, args: Object.keys(args), ok: true, ms: Date.now() - started })
    return res
  }
  catch (e) {
    const code = e instanceof B24Error ? e.code : 'internal'
    audit({ user: session.userId, tool, method, args: Object.keys(args), ok: false, error: code, ms: Date.now() - started })
    // Портал не принял токены: забываем их — следующий запрос к /mcp получит 401 и клиент войдёт заново.
    if (e instanceof ReloginRequired) {
      await useServices().b24.forget(session.userId)
      throw createError({ statusCode: 401, message: 'Вход в Битрикс24 истёк — повторите запрос, клиент предложит войти заново' })
    }
    // Клиенту — только код ошибки Битрикс24, без внутреннего текста.
    if (e instanceof B24Error) throw createError({ statusCode: 502, message: `Битрикс24 отказал: ${e.code}` })
    throw e
  }
}

/** Все инструменты сейчас только читают (шаг 4 плана): клиент может звать их без вопроса. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
