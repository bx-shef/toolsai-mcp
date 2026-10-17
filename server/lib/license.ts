import { createHash, createPublicKey, verify } from 'node:crypto'
import type { Store } from './store'

// Лицензия MCP-сервера на портал — тот же формат и тот же сервер, что у линейки
// (bx-shef/license-server, docs/module-licensing.md; образец — lib/license/ в bx-shef/toolsai).
// Сертификат BXL1.<base64url(JSON)>.<base64url(подпись Ed25519)> проверяется здесь без сети:
// открытый ключ, приложение (PRODUCT) и отпечаток портала известны заранее.
//
// Отпечаток портала: у MCP нет ключа лицензии Битрикс24 (облако и коробка обслуживаются одним
// сервером), поэтому ветка формулы «install» с install_id = member_id портала. member_id
// переживает переустановку приложения и смену домена; формулу не менять — её сверяет сервер.

export const PRODUCT = 'shef.toolsai-mcp'
/** Основная версия сервера: сертификат с max_major меньше — недействителен. */
export const MAJOR = 1
export const DEFAULT_SERVER = 'https://license.bx-shef.by'

/** Открытые ключи сервера лицензий: kid → base64 сырого ключа (тот же, что у shef.toolsai). */
export const PUBLIC_KEYS: Record<string, string> = {
  // license.bx-shef.by, ключ с 2026-10-10
  d4fcbc5d: 'hgUplPT/yQXutIb3OUiJfTFGIns6lsIvI586SqC/zwU=',
}

export const WARN_DAYS = 30
const NO_LINK_AFTER = 2 * 86400
const RENEW_AFTER = 20 * 3600
const RETRY_AFTER = 3600
const DAY = 86400

export const TYPE_TITLES: Record<string, string> = { trial: 'тестовая', annual: 'годовая', perpetual: 'бессрочная', offline: 'замкнутый контур' }

export type LicenseMode = 'unconfigured' | 'active' | 'none' | 'invalid' | 'expired'
export interface LicenseStatus {
  mode: LicenseMode
  message: string
  payload?: Record<string, unknown>
  daysLeft?: number | null
  warning?: boolean
  noLink?: boolean
}
export const isWorking = (s: LicenseStatus) => s.mode === 'unconfigured' || s.mode === 'active'

export function fingerprint(memberId: string): string {
  return createHash('sha256').update(`bxl-fp-v1|install|${memberId}`).digest('hex')
}

const b64url = (s: string) => /^[\w-]+$/.test(s) ? Buffer.from(s, 'base64url') : null
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10).split('-').reverse().join('.')

/** Данные сертификата, если подпись верна одним из ключей; иначе null. */
export function verifyCertificate(cert: string, keys: Record<string, string>): Record<string, unknown> | null {
  const parts = cert.trim().split('.')
  if (parts.length !== 3 || parts[0] !== 'BXL1') return null
  const json = b64url(parts[1]!), sig = b64url(parts[2]!)
  if (!json || !sig || sig.length !== 64) return null
  let payload: Record<string, unknown>
  try { payload = JSON.parse(json.toString('utf8')) }
  catch { return null }
  if (!payload || typeof payload !== 'object' || payload.v !== 1) return null
  const raw = keys[String(payload.kid ?? '')]
  const key = raw ? Buffer.from(raw, 'base64') : null
  if (!key || key.length !== 32) return null
  try {
    // Сырой ключ Ed25519 → SPKI: 12 байт заголовка DER + 32 байта ключа
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(`BXL1.${parts[1]}`), pub, sig) ? payload : null
  }
  catch {
    return null
  }
}

/** Состояние лицензии — чистая функция (как Status::evaluate в shef.toolsai). */
export function evaluate(cert: string | null, keys: Record<string, string>, fp: string, now: number, renewedAt: number | null = null): LicenseStatus {
  if (!Object.keys(keys).length) return { mode: 'unconfigured', message: 'Лицензирование в этой сборке не включено.' }
  if (!cert?.trim()) return { mode: 'none', message: 'Лицензия не активирована: ИИ не работает с этим порталом. Введите ключ или запросите тестовую лицензию.' }
  const p = verifyCertificate(cert, keys)
  if (!p) return { mode: 'invalid', message: 'Сертификат лицензии повреждён или подписан не тем ключом. Активируйте ключ заново.' }
  if (p.product !== PRODUCT) return { mode: 'invalid', message: `Сертификат выдан для другого приложения (${String(p.product ?? '—')}).`, payload: p }
  if (p.fp !== fp) return { mode: 'invalid', message: 'Сертификат выдан для другого портала. Нажмите «Перепривязать».', payload: p }
  const maxMajor = p.max_major
  if (maxMajor != null && (typeof maxMajor !== 'number' || MAJOR > maxMajor)) return { mode: 'invalid', message: `Лицензия действует для версий до ${maxMajor}.x, а сервер — ${MAJOR}.x.`, payload: p }
  const expiresAt = typeof p.expires_at === 'number' ? p.expires_at : null
  const validUntil = typeof p.valid_until === 'number' ? p.valid_until : 0
  const type = String(p.type ?? '')
  const title = TYPE_TITLES[type] ?? type
  if (expiresAt !== null && now >= expiresAt) return { mode: 'expired', message: `Срок лицензии (${title}) закончился ${date(expiresAt)}. Продлите лицензию.`, payload: p, daysLeft: 0 }
  if (now >= validUntil) {
    return { mode: 'expired', payload: p, daysLeft: 0, message: type === 'offline'
      ? `Срок сертификата закончился ${date(validUntil)}: нужен новый сертификат.`
      : `Нет связи с сервером лицензий с ${date(renewedAt ?? validUntil)}: сертификат не продлён.` }
  }
  const daysLeft = expiresAt !== null ? Math.ceil((expiresAt - now) / DAY) : null
  const noLink = type !== 'offline' && renewedAt !== null && now - renewedAt > NO_LINK_AFTER
  let message = `Лицензия действует: ${title}${expiresAt !== null ? `, до ${date(expiresAt)} (осталось ${daysLeft} дн.)` : ', без срока окончания'}.`
  if (noLink) message += ` Нет связи с сервером лицензий: работает по сохранённому сертификату до ${date(validUntil)}.`
  return { mode: 'active', message, payload: p, daysLeft, warning: daysLeft !== null && daysLeft <= WARN_DAYS, noLink }
}

/** Что хранится по порталу (Redis, lic:<member_id>). */
export interface LicenseRecord { key?: string, cert?: string, renewed?: number, try?: number, error?: string, maxseen?: number, eulaPending?: string, domain?: string }

export type Fetcher = (url: string, body: unknown) => Promise<{ status: number, json: unknown }>

const httpFetcher: Fetcher = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) })
  let json: unknown = null
  try { json = await r.json() }
  catch {}
  return { status: r.status, json }
}

const TTL = 10 * 365 * DAY

export class Licensing {
  constructor(
    private store: Store,
    private opts: { keys?: Record<string, string>, server?: string, required?: boolean, fetcher?: Fetcher, clock?: () => number } = {},
  ) {}

  get keys() { return this.opts.keys ?? PUBLIC_KEYS }
  /** Без лицензии ИИ не работает только при LICENSE_REQUIRED=1: включается после бессрочных лицензий действующим порталам. */
  get required() { return this.opts.required ?? false }

  private async rec(memberId: string): Promise<LicenseRecord> {
    return (await this.store.get<LicenseRecord>(`lic:${memberId}`)) ?? {}
  }

  private save(memberId: string, r: LicenseRecord) {
    return this.store.put(`lic:${memberId}`, r, TTL)
  }

  /** Время для сроков: перевод часов назад лицензию не продлевает. */
  private now(r: LicenseRecord): number {
    const t = Math.floor((this.opts.clock?.() ?? Date.now()) / 1000)
    if (t > (r.maxseen ?? 0)) r.maxseen = t
    return Math.max(t, r.maxseen ?? 0)
  }

  async status(memberId: string, renew = true): Promise<LicenseStatus & { key: string, error: string, eulaPending: string }> {
    let r = await this.rec(memberId)
    if (renew && r.key && Object.keys(this.keys).length) {
      const now = this.now(r)
      const offline = (r.cert && verifyCertificate(r.cert, this.keys)?.type) === 'offline'
      if (!offline && now - (r.renewed ?? 0) >= RENEW_AFTER && now - (r.try ?? 0) >= RETRY_AFTER) {
        await this.exchange(memberId, '', 'renew', { key: r.key })
        r = await this.rec(memberId)
      }
    }
    // Самое позднее виденное время — в хранилище (не чаще раза в час): перевод часов назад не продлевает
    const seen = r.maxseen ?? 0
    const now = this.now(r)
    if (r.cert && now - seen > 3600) await this.save(memberId, r)
    const st = evaluate(r.cert ?? null, this.keys, fingerprint(memberId), now, r.renewed ?? null)
    return { ...st, key: r.key ?? '', error: r.error ?? '', eulaPending: r.eulaPending ?? '' }
  }

  /** Гейт: можно ли ИИ работать с порталом. Ошибка проверки — «нет», если лицензия обязательна. */
  async allowed(memberId: string): Promise<boolean> {
    if (!this.required) return true
    try { return isWorking(await this.status(memberId)) }
    catch { return !Object.keys(this.keys).length }
  }

  activate(memberId: string, domain: string, key: string, eulaBy: string) {
    key = key.trim()
    if (!key) return Promise.resolve('Введите ключ лицензии.')
    if (!eulaBy) return Promise.resolve('Нужно принять лицензионное соглашение.')
    return this.exchange(memberId, domain, 'activate', { key, eula: { accepted: true, by: eulaBy } }, key)
  }

  trial(memberId: string, domain: string, c: { name: string, unp: string, email: string }, eulaBy: string) {
    const name = c.name.trim(), unp = c.unp.replace(/\D/g, ''), email = c.email.trim()
    if (!name || unp.length !== 9 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Promise.resolve('Для тестовой лицензии нужны название организации, УНП (9 цифр) и e-mail.')
    if (!eulaBy) return Promise.resolve('Нужно принять лицензионное соглашение.')
    return this.exchange(memberId, domain, 'trial', { customer: { name, unp, email }, eula: { accepted: true, by: eulaBy } })
  }

  async rebind(memberId: string, domain: string, key: string, eulaBy: string) {
    key = key.trim() || (await this.rec(memberId)).key || ''
    if (!key) return 'Введите ключ лицензии.'
    return this.exchange(memberId, domain, 'rebind', { key, ...(eulaBy ? { eula: { accepted: true, by: eulaBy } } : {}) }, key)
  }

  async renew(memberId: string, domain: string) {
    const key = (await this.rec(memberId)).key
    if (!key) return 'Ключ не введён.'
    return this.exchange(memberId, domain, 'renew', { key }, key)
  }

  async accept(memberId: string, domain: string, eulaBy: string) {
    const key = (await this.rec(memberId)).key
    if (!key) return 'Ключ не введён.'
    if (!eulaBy) return 'Нужно принять лицензионное соглашение.'
    return this.exchange(memberId, domain, 'accept', { key, eula: { accepted: true, by: eulaBy } }, key)
  }

  /** Вставить сертификат, выданный разработчиком вручную. */
  async install(memberId: string, cert: string) {
    const r = await this.rec(memberId)
    const st = evaluate(cert.trim(), this.keys, fingerprint(memberId), this.now(r))
    if (st.mode !== 'active') return st.message
    await this.save(memberId, { ...r, cert: cert.trim(), renewed: this.now(r), error: '' })
    return null
  }

  /** null — получилось, иначе текст ошибки. Ключ лицензии уходит только на сервер лицензий и только по https. */
  private async exchange(memberId: string, domain: string, action: string, data: Record<string, unknown>, key?: string): Promise<string | null> {
    const r = await this.rec(memberId)
    const now = this.now(r)
    r.try = now
    domain = domain || r.domain || ''
    r.domain = domain
    const url = `${(this.opts.server ?? DEFAULT_SERVER).replace(/\/$/, '')}/api/v1/${action}`
    const fail = async (msg: string, code: string) => {
      r.error = `${msg} (${code})`
      await this.save(memberId, r)
      return msg
    }
    if (!url.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return fail('Адрес сервера лицензий должен быть https://', 'not_https')
    let res: { status: number, json: unknown }
    try {
      res = await (this.opts.fetcher ?? httpFetcher)(url, { ...data, product: PRODUCT, fp: fingerprint(memberId), domain, version: `${MAJOR}.0.0` })
    }
    catch {
      return fail('Сервер лицензий не отвечает', 'no_link')
    }
    const j = (res.json && typeof res.json === 'object' ? res.json : null) as Record<string, unknown> | null
    if (!j) return fail(`Сервер лицензий ответил не JSON (HTTP ${res.status})`, 'bad_response')
    if (j.ok !== true || typeof j.certificate !== 'string') {
      return fail(typeof j.message === 'string' ? j.message.slice(0, 300) : `Сервер лицензий отказал (HTTP ${res.status})`, typeof j.error === 'string' ? j.error : `http_${res.status}`)
    }
    const st = evaluate(j.certificate, this.keys, fingerprint(memberId), now)
    if (st.mode !== 'active') return fail(`Сервер выдал негодный сертификат: ${st.message}`, 'bad_certificate')
    const pending = j.eula_pending && typeof j.eula_pending === 'object' ? String((j.eula_pending as Record<string, unknown>).version ?? '') : ''
    await this.save(memberId, { ...r, cert: j.certificate, key: typeof j.key === 'string' ? j.key : (key ?? r.key), renewed: now, error: '', eulaPending: pending })
    return null
  }
}
