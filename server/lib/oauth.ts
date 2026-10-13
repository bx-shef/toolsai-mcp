import type { B24 } from './b24'
import type { Config } from './config'
import { randomToken, sha256, verifyPkce } from './crypto'
import type { Store } from './store'

// Наш сервер авторизации OAuth 2.1 для MCP-клиентов (спецификация MCP, Authorization).
// Битрикс24 им для claude.ai быть не может (нет PKCE, метаданных, динамической регистрации),
// поэтому выдаём свои короткие токены, а сотрудника внутри /authorize ведём входить в портал.

export class OAuthError extends Error {
  constructor(readonly error: string, readonly description: string, readonly status = 400) {
    super(description)
  }
}

export interface Client { id: string, name: string, redirectUris: string[] }
interface Pending { clientId: string, redirectUri: string, challenge: string, state?: string, scope?: string }
interface Grant { clientId: string, redirectUri: string, challenge: string, userId: number }
export interface Session { userId: number, clientId: string }

const CODE_TTL = 120
const LOGIN_TTL = 600
const CLIENT_TTL = 365 * 24 * 3600

export const MCP_PATH = '/mcp'

export function protectedResourceMetadata(cfg: Config) {
  return {
    resource: `${cfg.publicUrl}${MCP_PATH}`,
    authorization_servers: [cfg.publicUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'Битрикс24 (toolsai-mcp)',
  }
}

export function authServerMetadata(cfg: Config) {
  const b = cfg.publicUrl
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  }
}

/** redirect_uri клиента: https или http только на свою машину (Claude Code, Inspector). */
function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 2000) return false
  try {
    const u = new URL(uri)
    if (u.hash) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  }
  catch {
    return false
  }
}

export class OAuthServer {
  constructor(private cfg: Config, private store: Store, private b24: B24) {}

  /** RFC 7591: только публичные клиенты (PKCE вместо секрета). */
  async register(body: any): Promise<Record<string, unknown>> {
    const uris = body?.redirect_uris
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirect)) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris: https или http://localhost')
    }
    const client: Client = { id: randomToken(16), name: String(body.client_name || 'MCP client').slice(0, 100), redirectUris: uris }
    await this.store.put(`client:${client.id}`, client, CLIENT_TTL)
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }
  }

  private async client(id: unknown): Promise<Client> {
    const c = typeof id === 'string' ? await this.store.get<Client>(`client:${id}`) : null
    if (!c) throw new OAuthError('invalid_client', 'Неизвестный client_id', 401)
    return c
  }

  /**
   * GET /oauth/authorize. Возвращает адрес входа на портал.
   * Ошибки до проверки redirect_uri показываются человеку, а не уводят по адресу (RFC 6749 4.1.2.1).
   */
  async authorize(q: Record<string, unknown>): Promise<string> {
    const client = await this.client(q.client_id)
    const redirectUri = String(q.redirect_uri ?? '')
    if (!client.redirectUris.includes(redirectUri)) throw new OAuthError('invalid_request', 'redirect_uri не зарегистрирован')
    if (q.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Только response_type=code')
    if (q.code_challenge_method !== 'S256' || typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
      throw new OAuthError('invalid_request', 'Нужен PKCE S256')
    }
    const txn = randomToken()
    const pending: Pending = {
      clientId: client.id,
      redirectUri,
      challenge: q.code_challenge,
      state: typeof q.state === 'string' ? q.state : undefined,
    }
    await this.store.put(`login:${txn}`, pending, LOGIN_TTL)
    return this.b24.authorizeUrl(txn)
  }

  /** GET /oauth/callback с портала. Возвращает, куда отправить браузер: клиенту с нашим кодом. */
  async callback(q: Record<string, unknown>): Promise<string> {
    const pending = typeof q.state === 'string' ? await this.store.take<Pending>(`login:${q.state}`) : null
    if (!pending) throw new OAuthError('invalid_request', 'Вход устарел или уже использован — начните подключение заново')
    if (typeof q.code !== 'string' || !q.code) throw new OAuthError('access_denied', 'Битрикс24 не вернул код')

    const back = new URL(pending.redirectUri)
    if (pending.state !== undefined) back.searchParams.set('state', pending.state)

    const { userId } = await this.b24.login(q.code, typeof q.server_domain === 'string' ? q.server_domain : undefined)
    if (this.cfg.allowedUsers.size && !this.cfg.allowedUsers.has(userId)) {
      await this.b24.forget(userId)
      back.searchParams.set('error', 'access_denied')
      back.searchParams.set('error_description', 'Доступ к MCP для этого сотрудника не открыт')
      return back.toString()
    }
    const code = randomToken()
    const grant: Grant = { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge, userId }
    await this.store.put(`code:${sha256(code)}`, grant, CODE_TTL)
    back.searchParams.set('code', code)
    return back.toString()
  }

  private async issue(userId: number, clientId: string) {
    const access = randomToken()
    const refresh = randomToken()
    const s: Session = { userId, clientId }
    await this.store.put(`at:${sha256(access)}`, s, this.cfg.accessTtlSec)
    await this.store.put(`rt:${sha256(refresh)}`, s, this.cfg.refreshTtlSec)
    return { access_token: access, token_type: 'Bearer', expires_in: this.cfg.accessTtlSec, refresh_token: refresh }
  }

  /** POST /oauth/token. Код сгорает и при неудачной попытке; refresh вращается — старый умирает при использовании. */
  async token(body: Record<string, unknown>) {
    const clientId = String(body.client_id ?? '')
    if (body.grant_type === 'authorization_code') {
      const grant = typeof body.code === 'string' ? await this.store.take<Grant>(`code:${sha256(body.code)}`) : null
      if (!grant) throw new OAuthError('invalid_grant', 'Код неверный или устарел')
      if (grant.clientId !== clientId || grant.redirectUri !== body.redirect_uri) throw new OAuthError('invalid_grant', 'Код выдан другому клиенту')
      if (typeof body.code_verifier !== 'string' || !verifyPkce(body.code_verifier, grant.challenge)) throw new OAuthError('invalid_grant', 'PKCE не сошёлся')
      return this.issue(grant.userId, grant.clientId)
    }
    if (body.grant_type === 'refresh_token') {
      const s = typeof body.refresh_token === 'string' ? await this.store.take<Session>(`rt:${sha256(body.refresh_token)}`) : null
      if (!s || s.clientId !== clientId) throw new OAuthError('invalid_grant', 'refresh_token неверный или устарел')
      if (this.cfg.allowedUsers.size && !this.cfg.allowedUsers.has(s.userId)) throw new OAuthError('invalid_grant', 'Доступ закрыт')
      return this.issue(s.userId, s.clientId)
    }
    throw new OAuthError('unsupported_grant_type', 'Только authorization_code и refresh_token')
  }

  /** Bearer запроса к /mcp → кто вызывает. null — 401. ALLOWED_USERS проверяется на каждом запросе. */
  async verify(authorization: string | undefined | null): Promise<Session | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    if (!m?.[1]) return null
    const s = await this.store.get<Session>(`at:${sha256(m[1])}`)
    if (!s) return null
    if (this.cfg.allowedUsers.size && !this.cfg.allowedUsers.has(s.userId)) return null
    return s
  }
}
