import { createHash, randomBytes } from 'node:crypto'
import { createStorage } from 'unstorage'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../server/lib/config'
import { decrypt, encrypt, verifyPkce } from '../server/lib/crypto'
import { Store } from '../server/lib/store'

const env = {
  PUBLIC_URL: 'https://b24.example/mcp-ai/',
  B24_PORTAL_URL: 'https://b24.example',
  B24_CLIENT_ID: 'local.x',
  B24_CLIENT_SECRET: 's',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ALLOWED_USERS: '1',
}

describe('config', () => {
  it('убирает хвостовой слэш, разбирает ALLOWED_USERS', () => {
    const c = loadConfig({ ...env, ALLOWED_USERS: '1, 15' })
    expect(c.publicUrl).toBe('https://b24.example/mcp-ai')
    expect(c.isAllowed(15)).toBe(true)
    expect(c.isAllowed(2)).toBe(false)
    expect(loadConfig({ ...env, ALLOWED_USERS: '*' }).isAllowed(999)).toBe(true)
  })
  it('пустой ALLOWED_USERS — отказ запуска (закрыто по умолчанию)', () => {
    expect(() => loadConfig({ ...env, ALLOWED_USERS: '' })).toThrow(/ALLOWED_USERS/)
    expect(() => loadConfig({ ...env, ALLOWED_USERS: ' , ' })).toThrow(/ALLOWED_USERS/)
  })
  it('сроки: опечатка — отказ запуска, а не «вечно истёкшие» токены', () => {
    expect(() => loadConfig({ ...env, ACCESS_TTL_SEC: '1h' })).toThrow(/ACCESS_TTL_SEC/)
    expect(loadConfig({ ...env, ACCESS_TTL_SEC: '600' }).accessTtlSec).toBe(600)
  })
  it('лишняя запятая в B24_OAUTH_SERVERS не ломает запуск', () => {
    expect(loadConfig({ ...env, B24_OAUTH_SERVERS: 'https://oauth.bitrix.info,' }).b24OAuthServers).toEqual(['https://oauth.bitrix.info'])
  })
  it('не https и не localhost — отказ', () => {
    expect(() => loadConfig({ ...env, PUBLIC_URL: 'http://b24.example' })).toThrow(/https/)
  })
  it('ключ не 32 байта — отказ', () => {
    expect(() => loadConfig({ ...env, ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/)
  })
  it('мусор в ALLOWED_USERS — отказ, а не «пусти всех»', () => {
    expect(() => loadConfig({ ...env, ALLOWED_USERS: 'ivanov' })).toThrow(/ALLOWED_USERS/)
  })
})

describe('crypto', () => {
  it('PKCE S256', () => {
    const v = randomBytes(32).toString('base64url')
    const ch = createHash('sha256').update(v).digest('base64url')
    expect(verifyPkce(v, ch)).toBe(true)
    expect(verifyPkce(`${v}x`, ch)).toBe(false)
    expect(verifyPkce('short', ch)).toBe(false)
    // RFC 7636: verifier от 43 символов — короткий не принимаем, даже если хэш сошёлся
    const v42 = 'a'.repeat(42)
    expect(verifyPkce(v42, createHash('sha256').update(v42).digest('base64url'))).toBe(false)
  })
  it('шифрование: обратимо, подмена — ошибка', () => {
    const k = randomBytes(32)
    const p = encrypt(k, 'refresh-token')
    expect(decrypt(k, p)).toBe('refresh-token')
    expect(() => decrypt(randomBytes(32), p)).toThrow()
  })
})

describe('store', () => {
  it('истекает по времени и take одноразовый', async () => {
    let now = 1000
    const s = new Store(createStorage(), () => now)
    await s.put('a', { x: 1 }, 10)
    expect(await s.take('a')).toEqual({ x: 1 })
    expect(await s.take('a')).toBeNull()
    await s.put('b', 1, 10)
    now += 10_001
    expect(await s.get('b')).toBeNull()
  })
  it('параллельный take отдаёт значение один раз', async () => {
    const s = new Store(createStorage())
    await s.put('c', 'code', 60)
    const r = await Promise.all([s.take('c'), s.take('c'), s.take('c')])
    expect(r.filter(Boolean)).toEqual(['code'])
  })
})
