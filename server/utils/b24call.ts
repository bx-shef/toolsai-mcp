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
    const result = await useServices().b24.call(session.userId, method, params)
    audit({ user: session.userId, tool, method, args: Object.keys(args), ok: true, ms: Date.now() - started })
    return result
  }
  catch (e) {
    const code = e instanceof B24Error ? e.code : 'internal'
    audit({ user: session.userId, tool, method, args: Object.keys(args), ok: false, error: code, ms: Date.now() - started })
    if (e instanceof ReloginRequired) throw createError({ statusCode: 401, message: 'Вход в Битрикс24 истёк — переподключите коннектор' })
    if (e instanceof B24Error) throw createError({ statusCode: 502, message: `Битрикс24: ${e.code}: ${e.message}` })
    throw e
  }
}

/** Все инструменты сейчас только читают (шаг 4 плана): клиент может звать их без вопроса. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
