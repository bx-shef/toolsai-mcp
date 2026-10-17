import { audit } from '../lib/audit'
import { B24Error, portalText, ReloginRequired } from '../lib/b24'
import { cleanText } from '../lib/manifest'
import type { Session } from '../lib/oauth'

/**
 * REST из инструмента от имени сотрудника, подключившего клиента.
 * Кто вызывает — из Bearer-токена (middleware 00.auth.ts), никогда не из аргументов инструмента.
 *
 * moduleText — инструмент модуля портала (манифест): к коду отказа добавляется текст, который
 * портал прислал в ответе (portalText(): только HTTP 4xx с кодом портала, не сетевые сбои и не наши
 * проверки), очищенный, в одну строку, до 300 знаков, — чтобы модель поняла, что исправить
 * («Выберите сотрудников или отделы»). Модули доверенные — их задаёт администратор; у встроенных
 * инструментов текст ядра по-прежнему не показываем.
 */
export async function b24Call(tool: string, method: string, params: Record<string, unknown>, args: object = {}, moduleText = false) {
  const session = useEvent().context.session as Session | undefined
  if (!session) throw createError({ statusCode: 401, message: 'Нет сессии' })
  // Лицензия портала: без неё ИИ не работает с порталом (при LICENSE_REQUIRED=1)
  if (!await useServices().license.allowed(session.memberId)) {
    throw createError({ statusCode: 402, message: 'Лицензия MCP на этот портал не активирована или истекла. Администратор Битрикс24 активирует её в настройках: /admin → «Лицензия».' })
  }
  const started = Date.now()
  try {
    const res = await useServices().b24.call(session, method, params)
    audit({ portal: session.host, member: session.memberId, user: session.userId, tool, method, args: Object.keys(args), ok: true, ms: Date.now() - started })
    return res
  }
  catch (e) {
    const code = e instanceof B24Error ? e.code : 'internal'
    audit({ portal: session.host, member: session.memberId, user: session.userId, tool, method, args: Object.keys(args), ok: false, error: code, ms: Date.now() - started })
    // Портал не принял токены: забываем их — следующий запрос к /mcp получит 401 и клиент войдёт заново.
    if (e instanceof ReloginRequired) {
      await useServices().b24.forget(session)
      throw createError({ statusCode: 401, message: 'Вход в Битрикс24 истёк — повторите запрос, клиент предложит войти заново' })
    }
    // Отсутствие записи — отдельно: модель должна понять, что ID неверный, а не что портал сломан.
    if (e instanceof B24Error && e.code === 'NOT_FOUND') throw createError({ statusCode: 404, message: 'Не найдено: записи с таким ID нет или она недоступна сотруднику' })
    // Клиенту — только код ошибки Битрикс24, без внутреннего текста; модулю — с его текстом.
    if (e instanceof B24Error) {
      const text = moduleText ? cleanText(portalText(e), 300, true) : ''
      throw createError({ statusCode: 502, message: `Битрикс24 отказал: ${e.code}${text ? ` — ${text}` : ''}` })
    }
    throw e
  }
}

/** Все инструменты сейчас только читают (шаг 4 плана): клиент может звать их без вопроса. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
