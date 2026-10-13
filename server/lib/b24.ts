import type { Config } from './config'
import { decrypt, encrypt } from './crypto'
import { withLock } from './lock'
import type { Store } from './store'

// Сторона Битрикс24: обмен кода, обновление токенов, REST от имени сотрудника.
// Токены живут только здесь (Redis), refresh — зашифрован. MCP-клиент их не видит никогда.

export type Fetch = typeof fetch

export interface B24Tokens {
  access: string
  refreshEnc: string
  /** ms epoch */
  expiresAt: number
  /** OAuth-сервер, выдавший токены, — refresh идёт туда же. */
  server: string
}

export class B24Error extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message)
  }
}

/** Битрикс24 не принял токены сотрудника — нужен новый вход. */
export class ReloginRequired extends B24Error {}

/** Ответ REST: result и, у списков, next (смещение следующей страницы) и total. */
export interface RestResult { result: any, next?: number, total?: number }

const AUTH_ERRORS = new Set(['invalid_token', 'NO_AUTH_FOUND', 'invalid_grant', 'expired_token'])
const tokenKey = (userId: number) => `b24:tokens:${userId}`

export class B24 {
  constructor(private cfg: Config, private store: Store, private fetchFn: Fetch = fetch, private now = () => Date.now()) {}

  /** Страница входа портала; вернёт на путь обработчика локального приложения. */
  authorizeUrl(state: string): string {
    const u = new URL(`${this.cfg.portalUrl}/oauth/authorize/`)
    u.searchParams.set('client_id', this.cfg.b24ClientId)
    u.searchParams.set('state', state)
    return u.toString()
  }

  /** server_domain из возврата — только из списка: иначе подменённый возврат унёс бы client_secret. */
  pickServer(serverDomain: string | undefined): string {
    if (!serverDomain) return this.cfg.b24OAuthServers[0]!
    const found = this.cfg.b24OAuthServers.find(s => new URL(s).host === serverDomain)
    if (!found) throw new B24Error('bad_server', `OAuth-сервер ${serverDomain} не в списке B24_OAUTH_SERVERS`)
    return found
  }

  private async tokenRequest(server: string, params: Record<string, string>) {
    const u = new URL(`${server}/oauth/token/`)
    for (const [k, v] of Object.entries({ ...params, client_id: this.cfg.b24ClientId, client_secret: this.cfg.b24ClientSecret })) {
      u.searchParams.set(k, v)
    }
    const res = await this.fetchFn(u, { signal: AbortSignal.timeout(15000) })
    const body = await res.json().catch(() => ({})) as Record<string, any>
    if (!res.ok || !body.access_token) {
      const code = String(body.error || `http_${res.status}`)
      const Err = AUTH_ERRORS.has(code) ? ReloginRequired : B24Error
      throw new Err(code, `OAuth Битрикс24: ${code}`, res.status)
    }
    return body
  }

  private async save(userId: number, body: Record<string, any>, server: string): Promise<B24Tokens> {
    const t: B24Tokens = {
      access: body.access_token,
      refreshEnc: encrypt(this.cfg.encryptionKey, body.refresh_token),
      expiresAt: this.now() + Number(body.expires_in || 3600) * 1000,
      server,
    }
    await this.store.put(tokenKey(userId), t, this.cfg.refreshTtlSec)
    return t
  }

  /** Обменять код с портала на токены и узнать, кто вошёл. */
  async login(code: string, serverDomain?: string): Promise<{ userId: number, name: string }> {
    const server = this.pickServer(serverDomain)
    const body = await this.tokenRequest(server, { grant_type: 'authorization_code', code })
    const { result: me } = await this.rest(body.access_token, 'user.current', {})
    const userId = Number(me.ID)
    if (!Number.isInteger(userId) || userId <= 0) throw new B24Error('bad_user', 'user.current не вернул ID')
    await withLock(tokenKey(userId), () => this.save(userId, body, server))
    return { userId, name: [me.NAME, me.LAST_NAME].filter(Boolean).join(' ') }
  }

  async hasTokens(userId: number): Promise<boolean> {
    return (await this.store.get(tokenKey(userId))) !== null
  }

  async forget(userId: number) {
    await this.store.del(tokenKey(userId))
  }

  /** Действующий access; refresh в Битрикс24 одноразовый — поэтому под блокировкой на сотрудника. */
  private token(userId: number, force = false): Promise<string> {
    return withLock(tokenKey(userId), async () => {
      const t = await this.store.get<B24Tokens>(tokenKey(userId))
      if (!t) throw new ReloginRequired('no_tokens', 'Нет входа в Битрикс24 — подключитесь заново')
      if (!force && t.expiresAt - this.now() > 60_000) return t.access
      const refresh = decrypt(this.cfg.encryptionKey, t.refreshEnc)
      try {
        const body = await this.tokenRequest(t.server, { grant_type: 'refresh_token', refresh_token: refresh })
        return (await this.save(userId, body, t.server)).access
      }
      catch (e) {
        // Мёртвый refresh не держим: иначе каждый вызов снова бился бы в OAuth-сервер,
        // а наш токен клиента оставался бы «живым» (OAuthServer.verify смотрит на наличие токенов).
        if (e instanceof ReloginRequired) await this.store.del(tokenKey(userId))
        throw e
      }
    })
  }

  private async rest(access: string, method: string, params: Record<string, unknown>): Promise<RestResult> {
    if (!/^[a-z0-9_.]+$/i.test(method)) throw new B24Error('bad_method', `Недопустимое имя метода: ${method}`)
    const res = await this.fetchFn(`${this.cfg.portalUrl}/rest/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: access }),
      signal: AbortSignal.timeout(30000),
    })
    const body = await res.json().catch(() => ({})) as Record<string, any>
    if (body.error || !res.ok) {
      const code = String(body.error || `http_${res.status}`)
      const Err = AUTH_ERRORS.has(code) ? ReloginRequired : B24Error
      throw new Err(code, String(body.error_description || code), res.status)
    }
    return { result: body.result, next: body.next, total: body.total }
  }

  /** REST от имени сотрудника — действуют его права в Битрикс24. На expired_token — одно обновление и повтор. */
  async call(userId: number, method: string, params: Record<string, unknown> = {}): Promise<RestResult> {
    try {
      return await this.rest(await this.token(userId), method, params)
    }
    catch (e) {
      if (!(e instanceof ReloginRequired) || e.code !== 'expired_token') throw e
      return this.rest(await this.token(userId, true), method, params)
    }
  }
}
