// Настройки из окружения (.env на сервере, образец — .env.example).
// Читаются один раз и проверяются: опечатка в адресе должна остановить запуск, а не всплыть при первом входе.

export interface Config {
  /** Адрес сервера, как его видят клиенты, без слэша на конце. */
  publicUrl: string
  /** Адрес портала, например https://b24.stuttgart.by */
  portalUrl: string
  b24ClientId: string
  b24ClientSecret: string
  /** OAuth-серверы Битрикс24, которым верим; первый — по умолчанию. */
  b24OAuthServers: string[]
  /** Ключ 32 байта для токенов Битрикс24 в Redis. */
  encryptionKey: Buffer
  /** Открыт ли вход сотруднику: ALLOWED_USERS — список ID или «*» (все сотрудники портала). */
  isAllowed: (userId: number) => boolean
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

  // Закрыто по умолчанию: пустой список — ошибка запуска, «все» надо сказать явно.
  const rawAllowed = required('ALLOWED_USERS')
  const allowed = new Set<number>()
  if (rawAllowed !== '*') {
    for (const part of rawAllowed.split(',')) {
      const t = part.trim()
      if (!t) continue
      if (!/^\d+$/.test(t)) throw new Error('ALLOWED_USERS: comma-separated Bitrix24 user IDs or *')
      allowed.add(Number(t))
    }
    if (!allowed.size) throw new Error('ALLOWED_USERS: comma-separated Bitrix24 user IDs or *')
  }

  const ttl = (name: string, def: number) => {
    const v = env[name]?.trim()
    if (!v) return def
    if (!/^\d+$/.test(v) || Number(v) < 60) throw new Error(`${name}: whole seconds, at least 60`)
    return Number(v)
  }

  return {
    publicUrl: url('PUBLIC_URL', env.PUBLIC_URL),
    portalUrl: url('B24_PORTAL_URL', env.B24_PORTAL_URL),
    b24ClientId: required('B24_CLIENT_ID'),
    b24ClientSecret: required('B24_CLIENT_SECRET'),
    b24OAuthServers: servers,
    encryptionKey: key,
    isAllowed: rawAllowed === '*' ? () => true : (id: number) => allowed.has(id),
    accessTtlSec: ttl('ACCESS_TTL_SEC', 3600),
    refreshTtlSec: ttl('REFRESH_TTL_SEC', 30 * 24 * 3600),
  }
}
