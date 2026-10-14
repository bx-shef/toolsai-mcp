// Инструменты модулей портала: модуль сам описывает свои функции методом-манифестом
// (например shef.mcp.tools), сервер показывает их модели как отдельные инструменты.
// Здесь — только разбор манифеста; вызов — server/plugins/module-tools.ts.

export type ToolKind = 'read' | 'write' | 'delete'

export interface ModuleTool {
  name: string
  title?: string
  description: string
  /** REST-метод модуля, который выполняет инструмент. */
  method: string
  /** JSON Schema аргументов (объект). */
  input: Record<string, unknown>
  kind: ToolKind
}

export const MAX_TOOLS = 50
const MAX_SCHEMA = 8_000

/** Префикс методов, которые может назвать манифест: вендор метода-манифеста («shef.mcp.tools» → «shef.»). */
export function vendorPrefix(manifestMethod: string): string {
  return `${manifestMethod.split('.')[0]}.`
}

/**
 * Разобрать ответ манифеста. Плохая запись не роняет остальные — пропускается с причиной
 * (причины пишем в журнал, модели не показываем).
 * reserved — имена встроенных инструментов: модуль их не перекрывает.
 */
export function parseManifest(raw: unknown, manifestMethod: string, reserved: Set<string>): { tools: ModuleTool[], errors: string[] } {
  const tools: ModuleTool[] = []
  const errors: string[] = []
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as any).tools) ? (raw as any).tools : null)
  if (!list) return { tools, errors: ['манифест — не массив и не {tools: [...]}'] }
  const prefix = vendorPrefix(manifestMethod)
  const seen = new Set<string>()
  for (const [i, t] of list.entries()) {
    const at = `#${i}`
    if (tools.length >= MAX_TOOLS) {
      errors.push(`больше ${MAX_TOOLS} инструментов — лишние пропущены`)
      break
    }
    if (!t || typeof t !== 'object') {
      errors.push(`${at}: не объект`)
      continue
    }
    const name = String(t.name ?? '')
    if (!/^[a-z][a-z0-9_]{1,47}$/.test(name)) {
      errors.push(`${at}: имя "${name.slice(0, 50)}" — латиница, цифры, _ (2–48)`)
      continue
    }
    if (reserved.has(name) || seen.has(name)) {
      errors.push(`${name}: имя уже занято`)
      continue
    }
    const method = String(t.method ?? '')
    // Только методы того же вендора: манифест не может выдать модели crm.deal.delete или чужой модуль.
    if (!/^[a-z0-9_.]+$/i.test(method) || !method.toLowerCase().startsWith(prefix.toLowerCase()) || method === manifestMethod) {
      errors.push(`${name}: метод "${method.slice(0, 80)}" — только ${prefix}*`)
      continue
    }
    const kind = t.kind ?? 'read'
    if (!['read', 'write', 'delete'].includes(kind)) {
      errors.push(`${name}: kind — read, write или delete`)
      continue
    }
    const description = typeof t.description === 'string' ? t.description.trim().slice(0, 1000) : ''
    if (!description) {
      errors.push(`${name}: нужно description — по нему модель решает, когда звать инструмент`)
      continue
    }
    const input = t.input ?? { type: 'object', properties: {} }
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input as any).type !== 'object' || JSON.stringify(input).length > MAX_SCHEMA) {
      errors.push(`${name}: input — JSON Schema с type: object, до ${MAX_SCHEMA} символов`)
      continue
    }
    seen.add(name)
    tools.push({ name, method, kind, description, input, ...(typeof t.title === 'string' && t.title.trim() ? { title: t.title.trim().slice(0, 100) } : {}) })
  }
  return { tools, errors }
}

/** Подсказки клиенту: запись и удаление он показывает человеку на подтверждение. */
export function annotationsFor(kind: ToolKind) {
  if (kind === 'read') return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  return { readOnlyHint: false, destructiveHint: kind === 'delete', idempotentHint: false, openWorldHint: false }
}

/** Имена встроенных инструментов (server/mcp/tools): модуль их не перекрывает. Сверку держит tests/repo.test.ts. */
export const BUILTIN_TOOLS = new Set(['user_current', 'crm_activity_list', 'crm_company_get', 'crm_contact_get', 'crm_deal_get', 'crm_deal_list', 'crm_lead_get', 'task_get', 'task_list'])
