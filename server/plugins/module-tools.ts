import { z } from 'zod'
import { B24Error, ReloginRequired } from '../lib/b24'
import { annotationsFor, BUILTIN_TOOLS, parseManifest, pickArgs, type ModuleTool } from '../lib/manifest'
import type { Session } from '../lib/oauth'

// Инструменты модулей портала. На каждый запрос к /mcp toolkit строит свой McpServer — в этот момент
// (хук mcp:server:created) читаем манифест модуля от имени сотрудника и регистрируем его функции
// отдельными инструментами. Манифест кешируется на 5 минут на сотрудника: модуль может отдавать
// разным сотрудникам разный набор, отзыв права доходит до 5 минут.

const CACHE_SEC = 300
/** «Модуля нет» / «нет права» — состояние портала: помним минуту, чтобы не бить в портал на каждом запросе. */
const ABSENT_CACHE_SEC = 60
/** Манифест не успел — без его инструментов в этот раз, но встроенные работают. */
const MANIFEST_TIMEOUT_MS = 3000
const ABSENT = new Set(['ERROR_METHOD_NOT_FOUND', 'insufficient_scope', 'ACCESS_DENIED', 'NOT_FOUND'])

interface Ready { tool: ModuleTool, input: z.ZodType }
const inflight = new Map<string, Promise<ModuleTool[]>>()

async function load(session: Session, method: string, key: string): Promise<ModuleTool[]> {
  const { b24, store } = useServices()
  try {
    const res = await b24.call(session, method, {})
    const parsed = parseManifest(res.result, method, BUILTIN_TOOLS)
    // Схема, которую zod не разбирает, отсеивается здесь, а не на каждом запросе.
    const tools = parsed.tools.filter((t) => {
      try {
        z.fromJSONSchema(t.input as never)
        return true
      }
      catch {
        parsed.errors.push(`${t.name}: input не разобран`)
        return false
      }
    })
    if (parsed.errors.length) console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method, errors: parsed.errors }))
    await store.put(key, tools, CACHE_SEC)
    return tools
  }
  catch (e) {
    const code = e instanceof B24Error ? e.code : 'internal'
    console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method, error: code }))
    // Вход истёк — забываем токены: следующий запрос получит 401, и клиент войдёт заново (как в b24Call).
    if (e instanceof ReloginRequired) await b24.forget(session)
    // Модуля нет или нет права — помним минуту; сбой сети и 5xx не кешируем — следующий запрос попробует снова.
    else if (ABSENT.has(code)) await store.put(key, [], ABSENT_CACHE_SEC)
    return []
  }
}

async function manifestFor(session: Session, method: string): Promise<ModuleTool[]> {
  const key = `manifest:${session.memberId}:${session.userId}:${method}`
  const cached = await useServices().store.get<ModuleTool[]>(key)
  if (cached) return cached
  // Параллельные запросы одного сотрудника ждут один вызов манифеста.
  let p = inflight.get(key)
  if (!p) {
    p = load(session, method, key).finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ModuleTool[]>((resolve) => {
    timer = setTimeout(() => {
      console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method, error: 'timeout' }))
      resolve([])
    }, MANIFEST_TIMEOUT_MS)
  })
  try {
    return await Promise.race([p, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('mcp:server:created', async ({ server, event }) => {
    const session = event.context.session as Session | undefined
    if (!session) return
    const { cfg } = useServices()
    const lists = await Promise.all(cfg.moduleManifests.map(m => manifestFor(session, m).then(tools => ({ m, tools }))))
    const taken = new Set(BUILTIN_TOOLS)
    for (const { m: manifest, tools } of lists) {
      for (const tool of tools) {
        // Запись и удаление — только тем, кому открыто WRITE_USERS; остальным инструмента просто нет.
        if (tool.kind !== 'read' && !cfg.canWrite(session)) continue
        // Одно имя в двух модулях — берём первый, второй в журнал: дубль уронил бы весь /mcp.
        if (taken.has(tool.name)) {
          console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method: manifest, errors: [`${tool.name}: имя уже занято другим модулем`] }))
          continue
        }
        taken.add(tool.name)
        const ready: Ready = { tool, input: z.fromJSONSchema(tool.input as never) as z.ZodType }
        try {
          server.registerTool(tool.name, {
            title: tool.title,
            description: tool.description,
            inputSchema: ready.input as never,
            annotations: annotationsFor(tool.kind),
            _meta: { module: manifest, kind: tool.kind },
          }, (async (args: Record<string, unknown>) => {
            // Методу — только ключи из схемы: лишнее (служебные параметры REST, то, что модуль читает
            // сверх схемы) модель не протащит.
            const params = pickArgs(tool.input, args)
            try {
              const res = await b24Call(`module:${tool.name}`, tool.method, params, params)
              const out = res.next !== undefined || res.total !== undefined ? { result: res.result, next: res.next ?? null, total: res.total } : res.result
              return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
            }
            catch (e) {
              const err = e as { statusCode?: number, message?: string }
              return { content: [{ type: 'text' as const, text: `[${err.statusCode ?? 500}] ${err.message ?? 'Ошибка'}` }], isError: true }
            }
          }) as never)
        }
        catch {
          console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method: manifest, errors: [`${tool.name}: не зарегистрирован`] }))
        }
      }
    }
  })
})
