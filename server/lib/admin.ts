import type { Access } from './access'
import type { B24, Who } from './b24'
import { portalHost } from './config'
import { randomToken, sha256 } from './crypto'
import { OAuthError } from './oauth'
import type { Store } from './store'

// Вход администратора портала на страницу настроек /admin. Тот же вход через приложение Битрикс24,
// что у сотрудников: кто вошёл и с какого портала — из ответа OAuth-сервера, не из браузера.
// Администратор ли он — штатный user.admin от его имени, на входе и при каждом сохранении.

/** state входа администратора — с приставкой: возврат с портала один на оба входа (/oauth/callback). */
export const ADMIN_STATE_PREFIX = 'adm.'
export const ADMIN_COOKIE = 'mcp_admin'
const LOGIN_TTL = 600
const SESSION_TTL = 3600

export interface AdminSession extends Who { csrf: string, name: string }

export class AdminAuth {
  constructor(private store: Store, private b24: B24, private access: Access) {}

  /** Начать вход: адрес портала от человека → state для cookie и страница входа портала. */
  async start(portalInput: unknown): Promise<{ state: string, url: string }> {
    const portal = typeof portalInput === 'string' ? portalHost(portalInput) : null
    if (!portal) throw new OAuthError('invalid_request', 'Не похоже на адрес Битрикс24 — например, mycompany.bitrix24.by')
    const state = `${ADMIN_STATE_PREFIX}${randomToken()}`
    await this.store.put(`adminlogin:${state}`, true, LOGIN_TTL)
    return { state, url: this.b24.authorizeUrl(portal, state) }
  }

  /** Возврат с портала: state совпал с cookie этого браузера → вход → только администратор → сессия. */
  async finish(q: Record<string, unknown>, cookie: string | undefined): Promise<string> {
    if (typeof q.state !== 'string' || !cookie || q.state !== cookie || !await this.store.take(`adminlogin:${q.state}`)) {
      throw new OAuthError('access_denied', 'Вход устарел или начат в другом браузере — откройте настройки заново', 403)
    }
    if (typeof q.code !== 'string' || !q.code) throw new OAuthError('access_denied', 'Битрикс24 не вернул код')
    const { name, ...who } = await this.b24.login(q.code, typeof q.server_domain === 'string' ? q.server_domain : undefined)
    if (!await this.access.isAdmin(who)) {
      throw new OAuthError('access_denied', 'Настройки доступны только администратору этого Битрикс24', 403)
    }
    const token = randomToken()
    const s: AdminSession = { ...who, name, csrf: randomToken(16) }
    await this.store.put(`adminsess:${sha256(token)}`, s, SESSION_TTL)
    return token
  }

  async session(token: string | undefined): Promise<AdminSession | null> {
    if (!token) return null
    return this.store.get<AdminSession>(`adminsess:${sha256(token)}`)
  }

  async logout(token: string | undefined) {
    if (token) await this.store.del(`adminsess:${sha256(token)}`)
  }
}
