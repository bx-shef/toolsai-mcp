import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createStorage } from 'unstorage'
import { describe, expect, it } from 'vitest'
import { evaluate, fingerprint, Licensing, PRODUCT, PUBLIC_KEYS, verifyCertificate, type Fetcher } from '../server/lib/license'
import { Store } from '../server/lib/store'

// Лицензия — формат bx-shef/license-server: подпись Ed25519 по строке «BXL1.<base64url(JSON)>».
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')
const keys = { kid1: raw }
const NOW = 1_800_000_000
const MEMBER = 'm0123456789abcdef'

function cert(p: Record<string, unknown>) {
  const body = `BXL1.${Buffer.from(JSON.stringify({ v: 1, kid: 'kid1', product: PRODUCT, type: 'annual', fp: fingerprint(MEMBER), expires_at: NOW + 100 * 86400, valid_until: NOW + 14 * 86400, max_major: 1, ...p })).toString('base64url')}`
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`
}

describe('сертификат', () => {
  it('подпись верна — данные; подмена байта, чужой kid, мусор — null', () => {
    expect(verifyCertificate(cert({}), keys)?.product).toBe(PRODUCT)
    const c = cert({})
    const [a, b, s] = c.split('.')
    const forged = `${a}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b!, 'base64url').toString()), type: 'perpetual' })).toString('base64url')}.${s}`
    expect(verifyCertificate(forged, keys)).toBeNull()
    expect(verifyCertificate(cert({ kid: 'other' }), keys)).toBeNull()
    expect(verifyCertificate('BXL1.xx.yy', keys)).toBeNull()
  })
  it('зашит ключ сервера лицензий линейки', () => {
    expect(Buffer.from(PUBLIC_KEYS.d4fcbc5d!, 'base64')).toHaveLength(32)
  })
  it('отпечаток — формула сервера, ветка install с member_id', () => {
    expect(fingerprint('abc')).toBe(createHash('sha256').update('bxl-fp-v1|install|abc').digest('hex'))
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'))
  })
})

describe('состояние', () => {
  const fp = fingerprint(MEMBER)
  it('ключей нет — лицензирование выключено; сертификата нет — none', () => {
    expect(evaluate(null, {}, fp, NOW).mode).toBe('unconfigured')
    expect(evaluate(null, keys, fp, NOW).mode).toBe('none')
  })
  it('действует; за 30 дней — warning; 3 дня без продления — noLink', () => {
    expect(evaluate(cert({}), keys, fp, NOW)).toMatchObject({ mode: 'active', warning: false, daysLeft: 100 })
    expect(evaluate(cert({ expires_at: NOW + 10 * 86400 }), keys, fp, NOW).warning).toBe(true)
    expect(evaluate(cert({}), keys, fp, NOW, NOW - 3 * 86400).noLink).toBe(true)
  })
  it('другое приложение, другой портал, старая основная версия — invalid', () => {
    expect(evaluate(cert({ product: 'shef.toolsai' }), keys, fp, NOW).mode).toBe('invalid')
    expect(evaluate(cert({}), keys, fingerprint('other'), NOW).mode).toBe('invalid')
    expect(evaluate(cert({ max_major: 0 }), keys, fp, NOW).mode).toBe('invalid')
  })
  it('срок вышел или сертификат не продлён — expired; бессрочная — без срока', () => {
    expect(evaluate(cert({ expires_at: NOW - 1 }), keys, fp, NOW).mode).toBe('expired')
    expect(evaluate(cert({ valid_until: NOW - 1 }), keys, fp, NOW).mode).toBe('expired')
    expect(evaluate(cert({ type: 'perpetual', expires_at: null }), keys, fp, NOW)).toMatchObject({ mode: 'active', daysLeft: null })
  })
})

describe('обмен с сервером и гейт', () => {
  const make = (answer: (url: string, body: any) => unknown, required = true) => {
    const calls: { url: string, body: any }[] = []
    const fetcher: Fetcher = async (url, body) => {
      calls.push({ url, body })
      return { status: 200, json: answer(url, body) }
    }
    const store = new Store(createStorage())
    let t = NOW * 1000
    const lic = new Licensing(store, { keys, required, fetcher, clock: () => t, server: 'https://lic.test' })
    return { lic, calls, tick: (sec: number) => { t += sec * 1000 } , back: (sec: number) => { t -= sec * 1000 } }
  }

  it('без лицензии — нельзя; активация с соглашением — можно; ключ и отпечаток уходят на сервер', async () => {
    const { lic, calls } = make(() => ({ ok: true, certificate: cert({}) }))
    expect(await lic.allowed(MEMBER)).toBe(false)
    expect(await lic.activate(MEMBER, 'a.bitrix24.by', 'K-1', '')).toMatch(/соглашение/)
    expect(calls).toHaveLength(0)
    expect(await lic.activate(MEMBER, 'a.bitrix24.by', 'K-1', 'Админ')).toBeNull()
    expect(calls[0]).toMatchObject({ url: 'https://lic.test/api/v1/activate', body: { key: 'K-1', product: PRODUCT, fp: fingerprint(MEMBER), domain: 'a.bitrix24.by' } })
    expect(await lic.allowed(MEMBER)).toBe(true)
    expect(await lic.allowed('other-member')).toBe(false)
  })

  it('отказ сервера — его текст; негодный сертификат не сохраняется', async () => {
    const bad = make(() => ({ ok: false, error: 'not_found', message: 'Ключ не найден' }))
    expect(await bad.lic.activate(MEMBER, 'a', 'K', 'x')).toBe('Ключ не найден')
    const wrong = make(() => ({ ok: true, certificate: cert({ fp: 'x' }) }))
    expect(await wrong.lic.activate(MEMBER, 'a', 'K', 'x')).toMatch(/негодный/)
    expect(await wrong.lic.allowed(MEMBER)).toBe(false)
  })

  it('продление раз в сутки, при неудаче — не чаще раза в час; eula_pending запоминается', async () => {
    let fail = false
    const { lic, calls, tick } = make((url) => fail ? { ok: false, error: 'x', message: 'нет' } : { ok: true, certificate: cert({ valid_until: NOW + 30 * 86400 }), ...(url.endsWith('renew') ? { eula_pending: { version: 'v2' } } : {}) })
    await lic.activate(MEMBER, 'a', 'K', 'x')
    await lic.status(MEMBER)
    expect(calls).toHaveLength(1)
    tick(21 * 3600)
    expect((await lic.status(MEMBER)).eulaPending).toBe('v2')
    expect(calls.at(-1)?.url).toMatch(/renew$/)
    fail = true
    tick(21 * 3600)
    await lic.status(MEMBER)
    await lic.status(MEMBER)
    expect(calls).toHaveLength(3)
  })

  it('часы назад срок не продлевают', async () => {
    const { lic, tick, back } = make(() => ({ ok: true, certificate: cert({ type: 'perpetual', expires_at: NOW + 86400, valid_until: NOW + 86400 }) }))
    await lic.activate(MEMBER, 'a', 'K', 'x')
    tick(2 * 86400)
    expect((await lic.status(MEMBER, false)).mode).toBe('expired')
    back(2 * 86400)
    expect((await lic.status(MEMBER, false)).mode).toBe('expired')
  })

  it('LICENSE_REQUIRED выключен — работает без лицензии; тестовая — проверка полей до сервера', async () => {
    const { lic, calls } = make(() => ({ ok: true, certificate: cert({ type: 'trial' }) }), false)
    expect(await lic.allowed(MEMBER)).toBe(true)
    expect(await lic.trial(MEMBER, 'a', { name: 'ООО', unp: '123', email: 'a@b.by' }, 'x')).toMatch(/УНП/)
    expect(calls).toHaveLength(0)
    expect(await lic.trial(MEMBER, 'a', { name: 'ООО', unp: '123456789', email: 'a@b.by' }, 'x')).toBeNull()
    expect(calls[0]?.body.customer).toEqual({ name: 'ООО', unp: '123456789', email: 'a@b.by' })
  })

  it('сервер лицензий только по https', async () => {
    const store = new Store(createStorage())
    const lic = new Licensing(store, { keys, server: 'http://evil.example', fetcher: async () => { throw new Error('не должен звать') } })
    expect(await lic.activate(MEMBER, 'a', 'K', 'x')).toMatch(/https/)
  })
})
