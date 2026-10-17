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
const MAX_DEPTH = 6

/** Текст для модели без управляющих и bidi-символов: ими прячут инструкции от человека. */
export function cleanText(s: string, max: number, oneLine = false): string {
  // eslint-disable-next-line no-control-regex
  let t = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu, '')
  if (oneLine) t = t.replace(/\s+/g, ' ')
  // по кодовым точкам: не разрезать суррогатную пару (эмодзи) на границе
  return Array.from(t.trim()).slice(0, max).join('')
}

/** Схема без ссылок ($ref/$defs/$id/$anchor) и не глубже MAX_DEPTH: ссылки могут зацикливаться. */
function plainSchema(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH * 2) return false
  if (Array.isArray(v)) return v.every(x => plainSchema(x, depth + 1))
  if (!v || typeof v !== 'object') return true
  for (const [k, x] of Object.entries(v)) {
    if (['$ref', '$defs', 'definitions', '$id', '$anchor', '$dynamicRef', '$recursiveRef'].includes(k)) return false
    if (!plainSchema(x, depth + 1)) return false
  }
  return true
}

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
    const description = typeof t.description === 'string' ? cleanText(t.description, 1000) : ''
    if (!description) {
      errors.push(`${name}: нужно description — по нему модель решает, когда звать инструмент`)
      continue
    }
    const input = t.input ?? { type: 'object', properties: {} }
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input as any).type !== 'object' || JSON.stringify(input).length > MAX_SCHEMA || !plainSchema(input)) {
      errors.push(`${name}: input — JSON Schema с type: object, до ${MAX_SCHEMA} символов, без $ref`)
      continue
    }
    seen.add(name)
    const title = typeof t.title === 'string' ? cleanText(t.title, 100, true) : ''
    tools.push({ name, method, kind, description, input, ...(title ? { title } : {}) })
  }
  return { tools, errors }
}

/** Подсказки клиенту: запись и удаление он показывает человеку на подтверждение. */
export function annotationsFor(kind: ToolKind) {
  if (kind === 'read') return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  return { readOnlyHint: false, destructiveHint: kind === 'delete', idempotentHint: false, openWorldHint: false }
}

/** Имена встроенных инструментов (server/mcp/tools): модуль их не перекрывает. Сверку держит tests/repo.test.ts. */
export const BUILTIN_TOOLS = new Set(['user_current', 'crm_activity_list', 'crm_item_get', 'crm_item_list', 'crm_fields', 'crm_stages', 'crm_find', 'task_get', 'task_list',
  'calendar_events', 'calendar_busy', 'task_checklist', 'task_elapsed', 'task_results', 'task_comments',
  'note_bases', 'note_tree', 'note_search', 'note_get', 'im_chats', 'worktime_status', 'disk_storages', 'disk_folder', 'catalog_list', 'catalog_products', 'catalog_product_get', 'crm_doc_templates', 'calls_stats'])

/** Встроенная запись в задачи и календарь (plugins/write-tools.ts): только тем, кому открыта запись. */
export const WRITE_TOOLS = ['crm_item_add', 'crm_item_update', 'task_create', 'task_update', 'task_status', 'task_checklist_add', 'task_checklist_done', 'task_comment_add', 'task_result_add', 'task_time_add', 'calendar_event_add', 'note_add', 'note_update', 'im_message_send', 'worktime_action', 'disk_folder_add', 'disk_move', 'catalog_product_update', 'crm_doc_create'] as const

/** Ключи, которые модель может передать методу: только объявленные в схеме, без служебных REST. */
export function pickArgs(input: Record<string, unknown>, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const allowed = new Set(Object.keys((input.properties as Record<string, unknown>) ?? {}))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!allowed.has(k) || k === 'auth' || k === 'access_token' || k.startsWith('_')) continue
    out[k] = v
  }
  return out
}
