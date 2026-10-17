import type { B24, Who } from './b24'
import type { Config } from './config'
import type { Store } from './store'

// Права на портале — как у самого Битрикс24: администратор портала задаёт на странице /admin коды
// доступа (кто пользуется MCP, кто пишет через инструменты модулей) и включает манифесты модулей.
// Проверяет коды штатный user.access от имени сотрудника: отделы с подотделами, группы, «все
// сотрудники» Битрикс24 считает сам, мы оргструктуру не повторяем. Администратор портала по
// документации user.access проходит всегда — поэтому пустая настройка = «только администраторы».
// Списки из .env (ALLOWED_USERS, WRITE_USERS, MODULE_MANIFESTS) остаются запасным путём и добавляются.

/** Группы инструментов, которые администратор включает и выключает на /admin. */
export const TOOL_GROUPS = {
  crm: 'CRM: сделки, лиды, контакты, компании, дела',
  tasks: 'Задачи: чтение, комментарии, чек-листы, время',
  calendar: 'Календарь: события, занятость, встречи',
  kb: 'База знаний',
  messages: 'Сообщения: список чатов, написать сотруднику или в чат',
  worktime: 'Рабочее время: начать, пауза, закончить свой день',
  disk: 'Диск: папки и файлы, создать папку, переместить',
  catalog: 'Каталог: товары, цены, остатки, описания',
  calls: 'Телефония: статистика звонков',
  booking: 'Онлайн-запись: записи на приём',
  staff: 'Сотрудники: дни рождения',
  modules: 'Инструменты модулей портала',
} as const
export type ToolGroup = keyof typeof TOOL_GROUPS

/**
 * Группы, выключенные, пока администратор портала не включит их сам на /admin (решение владельца
 * 2026-10-17): персональные данные — записи клиентов на приём, дни рождения сотрудников. Новая группа
 * с такими данными добавляется сюда, иначе она откроется на всех порталах в момент выкладки.
 */
export const DEFAULT_OFF: readonly ToolGroup[] = ['booking', 'staff']

/** Группа инструмента — по приставке имени; user_current — всегда (без него клиент не знает, кто вошёл). */
export function toolGroup(name: string): ToolGroup | null {
  if (name.startsWith('crm_')) return 'crm'
  if (name.startsWith('task_')) return 'tasks'
  if (name.startsWith('calendar_')) return 'calendar'
  if (name.startsWith('note_')) return 'kb'
  if (name.startsWith('im_')) return 'messages'
  if (name.startsWith('worktime_')) return 'worktime'
  if (name.startsWith('disk_')) return 'disk'
  if (name.startsWith('catalog_')) return 'catalog'
  if (name.startsWith('calls_')) return 'calls'
  if (name.startsWith('booking_')) return 'booking'
  if (name.startsWith('staff_')) return 'staff'
  return null
}

export interface PortalSettings {
  /** Главный выключатель портала (как «Разрешить внешним AI-системам…» у Битрикс24): true — MCP закрыт всем. */
  disabled: boolean
  /** Выключенные группы инструментов. Пусто — включены все, кроме DEFAULT_OFF. */
  groupsOff: ToolGroup[]
  /** Группы из DEFAULT_OFF, которые администратор включил сам. */
  groupsOn?: ToolGroup[]
  /** Коды доступа: кто пользуется MCP. Пусто — только администраторы портала. */
  use: string[]
  /** Коды доступа: кому инструменты модулей на запись и удаление. Пусто — только администраторы. */
  write: string[]
  /** Методы-манифесты модулей портала. */
  manifests: string[]
  /** Растёт при каждом сохранении: старые ответы user.access в кеше перестают действовать сразу. */
  ver: number
  updatedBy?: number
  updatedAt?: number
}

const EMPTY: PortalSettings = { disabled: false, groupsOff: [], use: [], write: [], manifests: [], ver: 0 }
const MAX = 100
/** Проверка прав живёт 5 минут: user.access на каждый запрос к /mcp — лишняя нагрузка на портал. */
const CHECK_TTL = 300

/** Форматы кодов из документации user.access: U, G, AU, D, DR, IU, SG_A/E/K, CR. */
const CODE = /^(AU|CR|[UGD]\d+|DR\d+|IU\d+|SG\d+_[AEK])$/

/** Текст из поля «через запятую или с новой строки» → коды. Мусор — ошибка с его перечнем. */
export function parseCodes(raw: unknown): string[] {
  const parts = String(raw ?? '').split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
  const bad = parts.filter(p => !CODE.test(p))
  if (bad.length) throw new Error(`Не коды доступа Битрикс24: ${bad.slice(0, 5).join(', ')} (нужно U7, D3, DR3, G2, AU…)`)
  const out = [...new Set(parts)]
  if (out.length > MAX) throw new Error(`Не больше ${MAX} кодов`)
  return out
}

export function parseManifests(raw: unknown): string[] {
  const parts = String(raw ?? '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  const bad = parts.filter(p => !/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(p))
  if (bad.length) throw new Error(`Не имя REST-метода вида vendor.mcp.tools: ${bad.slice(0, 5).join(', ')}`)
  return [...new Set(parts)].slice(0, 20)
}

export class Access {
  constructor(private cfg: Config, private store: Store, private b24: B24) {}

  async settings(memberId: string): Promise<PortalSettings> {
    return { ...EMPTY, ...await this.store.get<PortalSettings>(`settings:${memberId}`) }
  }

  async save(memberId: string, s: Pick<PortalSettings, 'disabled' | 'groupsOff' | 'use' | 'write' | 'manifests'>, by: number): Promise<PortalSettings> {
    const prev = await this.settings(memberId)
    // Отмеченные на форме группы из DEFAULT_OFF — включены явно
    const groupsOn = DEFAULT_OFF.filter(g => !s.groupsOff.includes(g))
    const next: PortalSettings = { disabled: s.disabled, groupsOff: s.groupsOff, groupsOn, use: s.use, write: s.write, manifests: s.manifests, ver: prev.ver + 1, updatedBy: by, updatedAt: Date.now() }
    // Без срока по смыслу — 10 лет: Store требует TTL.
    await this.store.put(`settings:${memberId}`, next, 10 * 365 * 24 * 3600)
    return next
  }

  /** Администратор портала — штатный user.admin от его имени. Ошибка — «нет». */
  async isAdmin(w: Who): Promise<boolean> {
    try {
      return (await this.b24.call(w, 'user.admin')).result === true
    }
    catch (e) {
      console.warn(JSON.stringify({ kind: 'access', portal: w.host, user: w.userId, method: 'user.admin', error: e instanceof Error ? e.message : String(e) }))
      return false
    }
  }

  /** Есть ли у сотрудника хоть один из кодов (или он администратор). Ошибка портала — «нет»: закрыто по умолчанию. */
  private async has(w: Who, kind: 'use' | 'write', s: PortalSettings): Promise<boolean> {
    const key = `acc:${w.memberId}:${s.ver}:${kind}:${w.userId}`
    const cached = await this.store.get<boolean>(key)
    if (cached !== null) return cached
    const codes = s[kind]
    let ok: boolean
    try {
      ok = codes.length
        ? (await this.b24.call(w, 'user.access', { ACCESS: codes })).result === true
        : (await this.b24.call(w, 'user.admin')).result === true
    }
    catch (e) {
      // Не кешируем: сбой сети не должен закрывать доступ на 5 минут.
      console.warn(JSON.stringify({ kind: 'access', portal: w.host, user: w.userId, check: kind, error: e instanceof Error ? e.message : String(e) }))
      return false
    }
    await this.store.put(key, ok, CHECK_TTL)
    return ok
  }

  async canUse(w: Who): Promise<boolean> {
    if (!w.host || !w.memberId) return false
    const s = await this.settings(w.memberId)
    // Выключатель портала сильнее всего, и .env тоже: портал решает за себя
    if (s.disabled) return false
    if (this.cfg.isAllowed(w)) return true
    return this.has(w, 'use', s)
  }

  /** Выключенные группы инструментов портала. */
  async groupsOff(w: Who): Promise<Set<ToolGroup>> {
    return new Set(effectiveGroupsOff(await this.settings(w.memberId)))
  }

  async canWrite(w: Who): Promise<boolean> {
    if (!w.host || !w.memberId) return false
    if (this.cfg.canWrite(w)) return true
    return this.has(w, 'write', await this.settings(w.memberId))
  }

  async manifests(w: Who): Promise<string[]> {
    const s = await this.settings(w.memberId)
    if (s.groupsOff.includes('modules')) return []
    return [...new Set([...this.cfg.moduleManifests, ...s.manifests])]
  }
}

/** Флажки групп из формы (group_<код>=on — отмечена, значит включена) → выключенные группы. */
/** Выключенные группы с учётом DEFAULT_OFF: такие выключены, пока администратор не включил их явно. */
export function effectiveGroupsOff(s: Pick<PortalSettings, 'groupsOff' | 'groupsOn'>): ToolGroup[] {
  return [...new Set([...s.groupsOff, ...DEFAULT_OFF.filter(g => !(s.groupsOn ?? []).includes(g))])]
}

export function parseGroupsOff(body: Record<string, unknown>): ToolGroup[] {
  return (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter(g => !body[`group_${g}`])
}
