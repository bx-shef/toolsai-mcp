import { z } from 'zod'
import { B24Error } from '../lib/b24'
import { annotationsFor, BUILTIN_TOOLS, parseManifest, type ModuleTool } from '../lib/manifest'
import type { Session } from '../lib/oauth'

// Инструменты модулей портала. На каждый запрос к /mcp toolkit строит свой McpServer — в этот момент
// (хук mcp:server:created) читаем манифест модуля от имени сотрудника и регистрируем его функции
// отдельными инструментами. Манифест кешируется на 5 минут на сотрудника: модуль может отдавать
// разным сотрудникам разный набор.

const CACHE_SEC = 300
const FAIL_CACHE_SEC = 60

async function manifestFor(session: Session, method: string): Promise<ModuleTool[]> {
  const { b24, store } = useServices()
  const key = `manifest:${session.memberId}:${session.userId}:${method}`
  const cached = await store.get<ModuleTool[]>(key)
  if (cached) return cached
  let tools: ModuleTool[] = []
  try {
    const res = await b24.call(session, method, {})
    const parsed = parseManifest(res.result, method, BUILTIN_TOOLS)
    tools = parsed.tools
    if (parsed.errors.length) console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method, errors: parsed.errors }))
    await store.put(key, tools, CACHE_SEC)
  }
  catch (e) {
    // Модуля нет на этом портале (метод не найден) или нет права — просто без его инструментов.
    console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method, error: e instanceof B24Error ? e.code : 'internal' }))
    await store.put(key, [], FAIL_CACHE_SEC)
  }
  return tools
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('mcp:server:created', async ({ server, event }) => {
    const session = event.context.session as Session | undefined
    if (!session) return
    const { cfg } = useServices()
    for (const manifest of cfg.moduleManifests) {
      for (const tool of await manifestFor(session, manifest)) {
        // Запись и удаление — только тем, кому открыто WRITE_USERS; остальным инструмента просто нет.
        if (tool.kind !== 'read' && !cfg.canWrite(session)) continue
        let input
        try {
          input = z.fromJSONSchema(tool.input as never)
        }
        catch {
          console.warn(JSON.stringify({ kind: 'manifest', portal: session.host, method: manifest, errors: [`${tool.name}: input не разобран`] }))
          continue
        }
        server.registerTool(tool.name, {
          title: tool.title,
          description: tool.description,
          inputSchema: input as never,
          annotations: annotationsFor(tool.kind),
          _meta: { module: manifest, kind: tool.kind },
        }, (async (args: Record<string, unknown>) => {
          try {
            const res = await b24Call(`module:${tool.name}`, tool.method, args ?? {}, args ?? {})
            const out = res.next !== undefined || res.total !== undefined ? { result: res.result, next: res.next ?? null, total: res.total } : res.result
            return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
          }
          catch (e) {
            const err = e as { statusCode?: number, message?: string }
            return { content: [{ type: 'text' as const, text: `[${err.statusCode ?? 500}] ${err.message ?? 'Ошибка'}` }], isError: true }
          }
        }) as never)
      }
    }
  })
})
