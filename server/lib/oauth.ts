import type { B24, Who } from './b24'
import { portalHost, type Config } from './config'
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
interface Pending { clientId: string, clientName: string, redirectUri: string, challenge: string, state?: string, approved: boolean }
interface Grant extends Who { clientId: string, redirectUri: string, challenge: string }
export interface Session extends Who { clientId: string }

const CODE_TTL = 120
const LOGIN_TTL = 600
// Регистрация открыта всем (так требует MCP) — клиент живёт месяц, а не год: меньше мусора в Redis.
const CLIENT_TTL = 30 * 24 * 3600
/** Имя cookie, которая привязывает вход к браузеру, начавшему его. */
export const LOGIN_COOKIE = 'mcp_login'

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
    if (!body || typeof body !== 'object') throw new OAuthError('invalid_client_metadata', 'Нужен JSON с redirect_uris')
    const uris = body.redirect_uris
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
   * GET /oauth/authorize: проверить запрос и завести вход. Дальше — экран согласия (approve).
   * Ошибки до проверки redirect_uri показываются человеку, а не уводят по адресу (RFC 6749 4.1.2.1).
   */
  async authorize(q: Record<string, unknown>): Promise<{ txn: string, clientName: string, redirectHost: string }> {
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
      clientName: client.name,
      redirectUri,
      challenge: q.code_challenge,
      state: typeof q.state === 'string' ? q.state : undefined,
      approved: false,
    }
    await this.store.put(`login:${txn}`, pending, LOGIN_TTL)
    return { txn, clientName: client.name, redirectHost: new URL(redirectUri).host }
  }

  /**
   * POST /oauth/consent: человек на экране согласия разрешил или отказал.
   * Защита от подмены входа: txn в форме должен совпасть с cookie браузера, начавшего вход.
   * Иначе чужой клиент мог бы прислать сотруднику ссылку на портал и получить код с его правами.
   */
  async consent(txn: unknown, cookie: string | undefined, allow: boolean, portalInput?: unknown): Promise<string> {
    if (typeof txn !== 'string' || !cookie || txn !== cookie) throw new OAuthError('access_denied', 'Вход начат в другом браузере — начните подключение заново', 403)
    const pending = await this.store.get<Pending>(`login:${txn}`)
    if (!pending) throw new OAuthError('invalid_request', 'Вход устарел — начните подключение заново')
    if (!allow) {
      await this.store.del(`login:${txn}`)
      return this.back(pending, { error: 'access_denied', error_description: 'Сотрудник отказал' })
    }
    const portal = typeof portalInput === 'string' ? portalHost(portalInput) : null
    if (!portal) throw new OAuthError('invalid_request', 'Не похоже на адрес Битрикс24 — вернитесь и введите, например, mycompany.bitrix24.by')
    await this.store.put(`login:${txn}`, { ...pending, approved: true }, LOGIN_TTL)
    return this.b24.authorizeUrl(portal, txn)
  }

  private back(p: Pending, params: Record<string, string>): string {
    const u = new URL(p.redirectUri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    if (p.state !== undefined) u.searchParams.set('state', p.state)
    return u.toString()
  }

  /**
   * GET /oauth/callback с портала. Возвращает, куда отправить браузер: клиенту с кодом или с ошибкой.
   * После проверки входа любые сбои уходят клиенту редиректом (RFC 6749 4.1.2.1), а не JSON-ом в браузер.
   */
  async callback(q: Record<string, unknown>, cookie: string | undefined): Promise<string> {
    if (typeof q.state !== 'string' || !cookie || q.state !== cookie) {
      throw new OAuthError('access_denied', 'Вход начат в другом браузере — начните подключение заново', 403)
    }
    const pending = await this.store.take<Pending>(`login:${q.state}`)
    if (!pending?.approved) throw new OAuthError('invalid_request', 'Вход устарел или уже использован — начните подключение заново')
    if (typeof q.code !== 'string' || !q.code) {
      return this.back(pending, { error: 'access_denied', error_description: 'Битрикс24 не вернул код' })
    }
    let who: Who
    try {
      const { name: _name, ...w } = await this.b24.login(q.code, typeof q.server_domain === 'string' ? q.server_domain : undefined)
      who = w
    }
    catch (e) {
      console.error('[oauth] вход через Битрикс24:', e instanceof Error ? e.message : e)
      return this.back(pending, { error: 'server_error', error_description: 'Битрикс24 не выдал токены — попробуйте ещё раз' })
    }
    if (!this.cfg.isAllowed(who)) {
      await this.b24.forget(who)
      return this.back(pending, { error: 'access_denied', error_description: 'Доступ к MCP для этого сотрудника не открыт' })
    }
    const code = randomToken()
    const grant: Grant = { clientId: pending.clientId, redirectUri: pending.redirectUri, challenge: pending.challenge, ...who }
    await this.store.put(`code:${sha256(code)}`, grant, CODE_TTL)
    return this.back(pending, { code })
  }

  private async issue(w: Who, clientId: string) {
    const access = randomToken()
    const refresh = randomToken()
    const s: Session = { memberId: w.memberId, host: w.host, userId: w.userId, clientId }
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
      return this.issue(grant, grant.clientId)
    }
    if (body.grant_type === 'refresh_token') {
      const s = typeof body.refresh_token === 'string' ? await this.store.take<Session>(`rt:${sha256(body.refresh_token)}`) : null
      if (!s || s.clientId !== clientId) throw new OAuthError('invalid_grant', 'refresh_token неверный или устарел')
      if (!this.cfg.isAllowed(s)) throw new OAuthError('invalid_grant', 'Доступ закрыт')
      // Токенов Битрикс24 нет (отказ портала, истекли) — refresh бесполезен: клиент должен войти заново.
      if (!await this.b24.hasTokens(s)) throw new OAuthError('invalid_grant', 'Нужен новый вход через Битрикс24')
      return this.issue(s, s.clientId)
    }
    throw new OAuthError('unsupported_grant_type', 'Только authorization_code и refresh_token')
  }

  /** Bearer запроса к /mcp → кто вызывает. null — 401. ALLOWED_USERS и наличие токенов Битрикс24 — на каждом запросе. */
  async verify(authorization: string | undefined | null): Promise<Session | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    if (!m?.[1]) return null
    const s = await this.store.get<Session>(`at:${sha256(m[1])}`)
    if (!s) return null
    if (!this.cfg.isAllowed(s)) return null
    // Портал отозвал вход сотрудника — наш токен тоже не годится: 401 запустит новый вход у клиента.
    if (!await this.b24.hasTokens(s)) return null
    return s
  }
}
