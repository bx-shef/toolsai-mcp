import { B24OAuth } from '@bitrix24/b24jssdk'
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
  /** REST портала из ответа OAuth-сервера (client_endpoint), со слэшем на конце. */
  endpoint: string
}

/** Кто вызывает: сотрудник конкретного портала. member_id — постоянный ID портала, host — для списка доступа. */
export interface Who { memberId: string, host: string, userId: number }

export class B24Error extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) {
    super(message)
  }
}

/** Битрикс24 не принял токены сотрудника — нужен новый вход. */
export class ReloginRequired extends B24Error {}

/** Ответ REST: result и, у списков, next (смещение следующей страницы) и total. */
export interface RestResult { result: any, next?: number, total?: number }

/**
 * Транспорт REST: вызвать метод токеном access; refresh() — получить новый access, когда портал
 * сказал «токен истёк». Боевой — b24jssdk (лимиты портала, повторы на QUERY_LIMIT_EXCEEDED);
 * в тестах — fetch, чтобы подставлять ответы без сети.
 */
export type RestTransport = (
  ctx: { endpoint: string, access: string, refresh: () => Promise<string> },
  method: string,
  params: Record<string, unknown>,
) => Promise<RestResult>

/** Размер страницы списков REST v2 — у Битрикс24 он фиксирован. */
export const PAGE_SIZE = 50

const AUTH_ERRORS = new Set(['invalid_token', 'NO_AUTH_FOUND', 'invalid_grant', 'expired_token'])
const tokenKey = (w: Pick<Who, 'memberId' | 'userId'>) => `b24:tokens:${w.memberId}:${w.userId}`

export class B24 {
  constructor(
    private cfg: Config,
    private store: Store,
    private fetchFn: Fetch = fetch,
    private now = () => Date.now(),
    private transport: RestTransport = sdkTransport(cfg),
  ) {}

  /**
   * Страница входа портала, адрес которого назвал человек. Сервер туда сам не ходит — только браузер,
   * поэтому любой домен безопасен: REST пойдёт на адрес, который вернёт OAuth-сервер Битрикс24.
   */
  authorizeUrl(portal: string, state: string): string {
    const u = new URL(`https://${portal}/oauth/authorize/`)
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

  private async save(w: Who, body: Record<string, any>, server: string, endpoint: string): Promise<B24Tokens> {
    const t: B24Tokens = {
      access: body.access_token,
      refreshEnc: encrypt(this.cfg.encryptionKey, body.refresh_token),
      expiresAt: this.now() + Number(body.expires_in || 3600) * 1000,
      server,
      endpoint,
    }
    await this.store.put(tokenKey(w), t, this.cfg.refreshTtlSec)
    return t
  }

  /**
   * Обменять код с портала на токены и узнать, кто вошёл и с какого портала. Адрес REST и member_id
   * берём из ответа OAuth-сервера (он из B24_OAUTH_SERVERS), а не из параметров возврата — их браузер
   * мог подменить.
   */
  async login(code: string, serverDomain?: string): Promise<Who & { name: string }> {
    const server = this.pickServer(serverDomain)
    const body = await this.tokenRequest(server, { grant_type: 'authorization_code', code })
    const endpoint = restEndpoint(body.client_endpoint)
    const memberId = String(body.member_id ?? '')
    if (!endpoint || !/^[a-z0-9]{8,64}$/i.test(memberId)) throw new B24Error('bad_token_response', 'OAuth-сервер не вернул client_endpoint или member_id')
    const { result: me } = await this.transport(
      { endpoint, access: body.access_token, refresh: async () => { throw new ReloginRequired('expired_token', 'Токен истёк сразу после входа') } },
      'user.current', {},
    )
    const userId = Number(me.ID)
    if (!Number.isInteger(userId) || userId <= 0) throw new B24Error('bad_user', 'user.current не вернул ID')
    const who: Who = { memberId, host: new URL(endpoint).hostname, userId }
    await withLock(tokenKey(who), () => this.save(who, body, server, endpoint))
    return { ...who, name: [me.NAME, me.LAST_NAME].filter(Boolean).join(' ') }
  }

  async hasTokens(w: Who): Promise<boolean> {
    return (await this.store.get(tokenKey(w))) !== null
  }

  async forget(w: Who) {
    await this.store.del(tokenKey(w))
  }

  /** Действующий access; refresh в Битрикс24 одноразовый — поэтому под блокировкой на сотрудника. */
  /** staleAccess — токен, который портал отверг: обновляем, только если в хранилище всё ещё он. */
  private token(w: Who, staleAccess?: string): Promise<B24Tokens> {
    return withLock(tokenKey(w), async () => {
      const t = await this.store.get<B24Tokens>(tokenKey(w))
      if (!t) throw new ReloginRequired('no_tokens', 'Нет входа в Битрикс24 — подключитесь заново')
      if (staleAccess === undefined ? t.expiresAt - this.now() > 60_000 : t.access !== staleAccess) return t
      const refresh = decrypt(this.cfg.encryptionKey, t.refreshEnc)
      try {
        const body = await this.tokenRequest(t.server, { grant_type: 'refresh_token', refresh_token: refresh })
        // Адрес REST оставляем прежним: refresh не меняет портал.
        return await this.save(w, body, t.server, t.endpoint)
      }
      catch (e) {
        // Мёртвый refresh не держим: иначе каждый вызов снова бился бы в OAuth-сервер,
        // а наш токен клиента оставался бы «живым» (OAuthServer.verify смотрит на наличие токенов).
        if (e instanceof ReloginRequired) await this.store.del(tokenKey(w))
        throw e
      }
    })
  }

  /** REST от имени сотрудника — действуют его права в Битрикс24. Истёкший токен транспорт обновляет сам, один раз. */
  async call(w: Who, method: string, params: Record<string, unknown> = {}): Promise<RestResult> {
    if (!/^[a-z0-9_.]+$/i.test(method)) throw new B24Error('bad_method', `Недопустимое имя метода: ${method}`)
    const { access, endpoint } = await this.token(w)
    // Обновляем, только если в хранилище всё тот же отвергнутый токен: соседний вызов мог уже
    // получить свежий, а refresh у Битрикс24 одноразовый — лишнее обновление его сжигает.
    return this.transport({ endpoint, access, refresh: async () => (await this.token(w, access)).access }, method, params)
  }
}

/** client_endpoint из ответа OAuth-сервера → «https://портал/rest/». Только https (http — лишь локально, для тестов). */
export function restEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const u = new URL(value)
    const local = u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash) return null
    return `${u.origin}${u.pathname.replace(/\/*$/, '/')}`
  }
  catch {
    return null
  }
}

function restError(code: string, description: string, status = 0): B24Error {
  // «Не найдено» портал отдаёт с ПУСТЫМ кодом (`{"error":"","error_description":"Not found"}`,
  // замер 2026-10-13), а SDK подставляет вместо него код axios ERR_BAD_REQUEST — модель не отличит
  // отсутствие записи от своей ошибки в запросе.
  if ((!code || code === 'ERR_BAD_REQUEST' || code.startsWith('JSSDK_')) && /not found/i.test(description)) code = 'NOT_FOUND'
  const Err = AUTH_ERRORS.has(code) ? ReloginRequired : B24Error
  return new Err(code, description || code, status)
}

/**
 * Боевой транспорт — b24jssdk 3.0.0. Обмен кода и refresh остаются нашими (в SDK их нет либо
 * защита только внутри экземпляра): SDK получает готовый access и наш refresh через
 * setCustomRefreshAuth. Экземпляр на вызов: лимитер SDK действует только в пределах одного вызова
 * (общего лимита на сотрудника нет — issue #2), зато нет кеша токенов, который разошёлся бы с Redis.
 */
export function sdkTransport(cfg: Config): RestTransport {
  return async (ctx, method, params) => {
    const portal = new URL(ctx.endpoint)
    const b24 = new B24OAuth({
      accessToken: ctx.access,
      refreshToken: '',
      // Срок access мы проверяем сами (B24.token); SDK пусть не обновляет заранее.
      expires: Math.floor(Date.now() / 1000) + 3600,
      expiresIn: 3600,
      scope: '',
      domain: portal.host,
      clientEndpoint: ctx.endpoint,
      serverEndpoint: `${cfg.b24OAuthServers[0]}/rest/`,
      status: 'L',
      issuer: 'request',
    } as never, { clientId: cfg.b24ClientId, clientSecret: cfg.b24ClientSecret })
    let refreshError: unknown
    b24.setCustomRefreshAuth(async () => {
      try {
        const access = await ctx.refresh()
        return { access_token: access, refresh_token: '', expires: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600 } as never
      }
      catch (e) {
        refreshError = e
        throw e
      }
    })
    try {
      const res = await b24.actions.v2.call.make({ method, params })
      if (!res.isSuccess) {
        const err = res.getErrors().next().value as { code?: string, message?: string, status?: number } | undefined
        throw restError(String(err?.code ?? 'error'), String(err?.message ?? ''), err?.status ?? 0)
      }
      const start = Number(params.start ?? 0) || 0
      return {
        result: res.getData()?.result,
        next: res.isMore() ? start + PAGE_SIZE : undefined,
        total: res.getTotal(),
      }
    }
    catch (e) {
      // Наш refresh отказал (вход истёк) — отдаём его ошибку, а не обёртку SDK.
      if (refreshError) throw refreshError instanceof B24Error ? refreshError : new B24Error('refresh_failed', 'refresh failed', 0)
      if (e instanceof B24Error) throw e
      const err = e as { code?: string, message?: string, status?: number, originalError?: { response?: { data?: { error?: string, error_description?: string } } } }
      // При пустом коде портала SDK теряет его описание («Not found»); исходный ответ лежит в originalError.
      const raw = err.originalError?.response?.data
      if (raw && !raw.error && raw.error_description) throw restError('', String(raw.error_description), err.status ?? 0)
      throw restError(String(err.code ?? 'network_error'), String(err.message ?? ''), err.status ?? 0)
    }
  }
}

/** Транспорт на fetch — для тестов: те же правила, без SDK и без сети. */
export function fetchTransport(_cfg: Config, fetchFn: Fetch): RestTransport {
  const once = async (endpoint: string, access: string, method: string, params: Record<string, unknown>) => {
    const res = await fetchFn(`${endpoint}${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: access }),
    })
    const body = await res.json().catch(() => ({})) as Record<string, any>
    if (body.error || !res.ok) throw restError(String(body.error || `http_${res.status}`), String(body.error_description || ''), res.status)
    return { result: body.result, next: body.next, total: body.total }
  }
  return async (ctx, method, params) => {
    try {
      return await once(ctx.endpoint, ctx.access, method, params)
    }
    catch (e) {
      if (!(e instanceof ReloginRequired) || e.code !== 'expired_token') throw e
      return once(ctx.endpoint, await ctx.refresh(), method, params)
    }
  }
}
