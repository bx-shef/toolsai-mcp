// Настройки из окружения (.env на сервере, образец — .env.example).
// Читаются один раз и проверяются: опечатка в адресе должна остановить запуск, а не всплыть при первом входе.

export interface Config {
  /** Адрес сервера, как его видят клиенты, без слэша на конце. */
  publicUrl: string
  /**
   * Портал по умолчанию (необязателен): подставляется в поле входа, к нему относятся голые ID
   * в ALLOWED_USERS. Сервер работает с любым Битрикс24, где установлено приложение.
   */
  defaultPortal?: string
  b24ClientId: string
  b24ClientSecret: string
  /** OAuth-серверы Битрикс24, которым верим; первый — по умолчанию. */
  b24OAuthServers: string[]
  /** Ключ 32 байта для токенов Битрикс24 в Redis. */
  encryptionKey: Buffer
  /** Запасной список из .env (ALLOWED_USERS, см. parseAllowed); пусто — решают права на странице /admin. */
  isAllowed: (who: { host: string, memberId: string, userId: number }) => boolean
  /** Разрешить REST на localhost/127.0.0.1 — только когда сам сервер локальный (тесты, разработка). */
  allowLocalPortal: boolean
  /**
   * Методы-манифесты модулей портала (MODULE_MANIFESTS, через запятую): модуль описывает в нём свои
   * инструменты. Пусто — инструментов модулей нет.
   */
  moduleManifests: string[]
  /** Кому открыты инструменты модулей на запись и удаление (WRITE_USERS, формат ALLOWED_USERS). Пусто — никому. */
  canWrite: (who: { host: string, memberId: string, userId: number }) => boolean
  accessTtlSec: number
  refreshTtlSec: number
}

function url(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`)
  const u = new URL(value)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) {
    throw new Error(`${name} must be https`)
  }
  return value.replace(/\/+$/, '')
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const required = (name: string) => {
    const v = env[name]?.trim()
    if (!v) throw new Error(`${name} is required`)
    return v
  }
  const key = Buffer.from(required('ENCRYPTION_KEY'), 'base64')
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes in base64 (openssl rand -base64 32)')

  const servers = (env.B24_OAUTH_SERVERS || 'https://oauth.bitrix.info,https://oauth.bitrix24.tech')
    .split(',').map(s => s.trim()).filter(Boolean).map(s => url('B24_OAUTH_SERVERS', s))

  const defaultPortal = env.B24_PORTAL_URL?.trim() ? portalHost(env.B24_PORTAL_URL) ?? undefined : undefined
  if (env.B24_PORTAL_URL?.trim() && !defaultPortal) throw new Error('B24_PORTAL_URL: portal address like https://mycompany.bitrix24.by')
  // Необязателен: основной путь — права администратора портала на странице /admin (lib/access.ts).
  const isAllowed = env.ALLOWED_USERS?.trim() ? parseAllowed(env.ALLOWED_USERS, defaultPortal) : () => false

  const ttl = (name: string, def: number) => {
    const v = env[name]?.trim()
    if (!v) return def
    if (!/^\d+$/.test(v) || Number(v) < 60) throw new Error(`${name}: whole seconds, at least 60`)
    return Number(v)
  }

  return {
    publicUrl: url('PUBLIC_URL', env.PUBLIC_URL),
    allowLocalPortal: ['localhost', '127.0.0.1'].includes(new URL(url('PUBLIC_URL', env.PUBLIC_URL)).hostname),
    defaultPortal,
    b24ClientId: required('B24_CLIENT_ID'),
    b24ClientSecret: required('B24_CLIENT_SECRET'),
    b24OAuthServers: servers,
    encryptionKey: key,
    isAllowed,
    moduleManifests: (env.MODULE_MANIFESTS ?? '').split(',').map(s => s.trim()).filter(Boolean).map((m) => {
      if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(m)) throw new Error(`MODULE_MANIFESTS: "${m}" is not a REST method name like vendor.mcp.tools`)
      return m
    }),
    canWrite: env.WRITE_USERS?.trim() ? parseAllowed(env.WRITE_USERS, defaultPortal) : () => false,
    accessTtlSec: ttl('ACCESS_TTL_SEC', 3600),
    refreshTtlSec: ttl('REFRESH_TTL_SEC', 30 * 24 * 3600),
  }
}

/**
 * Адрес портала, как его ввёл человек («mycompany.bitrix24.by», «https://b24.firma.by/crm/»), → хост.
 * null — не похоже на адрес. Только хост: путь, порт и логин в адресе входа портала не нужны.
 */
export function portalHost(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  }
  catch {
    return null
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null
  const h = u.hostname
  // Хотя бы одна точка, только буквы/цифры/дефисы (кириллица приходит в punycode от URL).
  if (!/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(h)) return null
  return h
}

/**
 * ALLOWED_USERS — запасной список, кому открыт вход (основной путь — /admin). Мусор — ошибка запуска.
 *   *                         — все сотрудники любого портала, где стоит приложение
 *   mycompany.bitrix24.by     — все сотрудники этого портала
 *   mycompany.bitrix24.by:7   — сотрудник 7 этого портала
 *   member:<member_id>[:7]    — то же по постоянному ID портала
 *   7                         — сотрудник 7 портала по умолчанию (B24_PORTAL_URL)
 * Хост — это адрес, который портал сообщил OAuth-серверу о себе. У облака он подлинный, у коробки
 * его задаёт её администратор: для коробок надёжнее member_id (он не меняется и при переименовании).
 */
export function parseAllowed(raw: string, defaultPortal?: string): (who: { host: string, memberId: string, userId: number }) => boolean {
  const usage = 'ALLOWED_USERS: comma-separated portal, portal:userId, member:<id>[:userId], userId (with B24_PORTAL_URL) or *'
  if (raw.trim() === '*') return who => Boolean(who.host && who.memberId)
  const portals = new Set<string>()
  const users = new Set<string>()
  const members = new Set<string>()
  const memberUsers = new Set<string>()
  for (const part of raw.split(',')) {
    const t = part.trim()
    if (!t) continue
    const mm = /^member:([a-z0-9]{8,64})(?::(\d+))?$/i.exec(t)
    if (mm) {
      if (mm[2]) memberUsers.add(`${mm[1]!.toLowerCase()}:${mm[2]}`)
      else members.add(mm[1]!.toLowerCase())
      continue
    }
    if (/^member:/i.test(t)) throw new Error(`${usage}: bad entry "${t}"`)
    const m = /^(?:(.+):)?(\d+)$/.exec(t)
    if (m) {
      const portal = m[1] ? portalHost(m[1]) : defaultPortal
      if (!portal) throw new Error(m[1] ? `${usage}: bad portal "${m[1]}"` : `${usage}: bare ID "${t}" needs B24_PORTAL_URL`)
      users.add(`${portal}:${m[2]}`)
      continue
    }
    const portal = portalHost(t)
    if (!portal) throw new Error(`${usage}: bad entry "${t}"`)
    portals.add(portal)
  }
  if (!portals.size && !users.size && !members.size && !memberUsers.size) throw new Error(usage)
  return ({ host, memberId, userId }) => {
    // Сессия старой формы (до «любого портала») — без портала: не пускаем, пусть войдёт заново.
    if (!host || !memberId) return false
    const m = memberId.toLowerCase()
    return portals.has(host) || users.has(`${host}:${userId}`) || members.has(m) || memberUsers.has(`${m}:${userId}`)
  }
}
