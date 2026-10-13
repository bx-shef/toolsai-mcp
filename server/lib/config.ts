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
  /** ID сотрудников, кому открыт вход; пусто — всем сотрудникам портала. */
  allowedUsers: Set<number>
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
    .split(',').map(s => url('B24_OAUTH_SERVERS', s.trim())).filter(Boolean)

  const allowed = new Set<number>()
  for (const part of (env.ALLOWED_USERS || '').split(',')) {
    const t = part.trim()
    if (!t) continue
    if (!/^\d+$/.test(t)) throw new Error('ALLOWED_USERS: comma-separated Bitrix24 user IDs')
    allowed.add(Number(t))
  }

  return {
    publicUrl: url('PUBLIC_URL', env.PUBLIC_URL),
    portalUrl: url('B24_PORTAL_URL', env.B24_PORTAL_URL),
    b24ClientId: required('B24_CLIENT_ID'),
    b24ClientSecret: required('B24_CLIENT_SECRET'),
    b24OAuthServers: servers,
    encryptionKey: key,
    allowedUsers: allowed,
    accessTtlSec: Number(env.ACCESS_TTL_SEC || 3600),
    refreshTtlSec: Number(env.REFRESH_TTL_SEC || 30 * 24 * 3600),
  }
}
