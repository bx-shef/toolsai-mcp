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
    expect(c.isAllowed({ host: 'b24.example', memberId: 'm0123456789', userId: 15 })).toBe(true)
    expect(c.isAllowed({ host: 'b24.example', memberId: 'm0123456789', userId: 2 })).toBe(false)
    expect(c.isAllowed({ host: 'other.bitrix24.by', memberId: 'm0123456789', userId: 15 })).toBe(false)
    expect(loadConfig({ ...env, ALLOWED_USERS: '*' }).isAllowed({ host: 'any.bitrix24.by', memberId: 'm0123456789', userId: 999 })).toBe(true)
  })
  it('ALLOWED_USERS по порталам: портал целиком и портал:ID, без портала по умолчанию', () => {
    const { B24_PORTAL_URL: _, ...noPortal } = env
    const c = loadConfig({ ...noPortal, ALLOWED_USERS: 'a.bitrix24.by, https://B.bitrix24.ru:7' })
    expect(c.defaultPortal).toBeUndefined()
    expect(c.isAllowed({ host: 'a.bitrix24.by', memberId: 'm0123456789', userId: 123 })).toBe(true)
    expect(c.isAllowed({ host: 'b.bitrix24.ru', memberId: 'm0123456789', userId: 7 })).toBe(true)
    expect(c.isAllowed({ host: 'b.bitrix24.ru', memberId: 'm0123456789', userId: 8 })).toBe(false)
    expect(() => loadConfig({ ...noPortal, ALLOWED_USERS: '7' })).toThrow(/B24_PORTAL_URL/)
    expect(() => loadConfig({ ...noPortal, ALLOWED_USERS: 'member:x' })).toThrow(/ALLOWED_USERS/)
  })
  it('внутренние адреса: v4, v6, v4 в v6; публичные — нет', async () => {
    const { isPrivateIp } = await import('../server/lib/b24')
    for (const ip of ['10.1.1.1', '127.0.0.1', '169.254.169.254', '192.168.0.1', '172.20.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) expect(isPrivateIp(ip), ip).toBe(true)
    for (const ip of ['93.184.216.34', '8.8.8.8', '2a00:1450::1', '::ffff:8.8.8.8']) expect(isPrivateIp(ip), ip).toBe(false)
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

describe('manifest', async () => {
  const { parseManifest, annotationsFor } = await import('../server/lib/manifest')
  const ok = { name: 'kb_get', method: 'shef.kb.get', description: 'Статья', input: { type: 'object', properties: { id: { type: 'integer' } } } }
  it('годная запись проходит, kind по умолчанию — read; {tools:[...]} тоже принимается', () => {
    expect(parseManifest([ok], 'shef.mcp.tools', new Set()).tools).toEqual([{ ...ok, kind: 'read' }])
    expect(parseManifest({ tools: [ok] }, 'shef.mcp.tools', new Set()).tools).toHaveLength(1)
  })
  it('плохие записи отсеиваются с причиной, остальные остаются', () => {
    const bad = [
      { ...ok, name: 'Bad-Name' },
      { ...ok, name: 'a1', method: 'crm.deal.delete' },
      { ...ok, name: 'a2', method: 'shef.mcp.tools' },
      { ...ok, name: 'a3', method: 'shefx.kb.get' },
      { ...ok, name: 'a4', kind: 'exec' },
      { ...ok, name: 'a5', description: '' },
      { ...ok, name: 'a6', input: { type: 'string' } },
      { ...ok, name: 'user_current' },
      ok, ok,
    ]
    const r = parseManifest(bad, 'shef.mcp.tools', new Set(['user_current']))
    expect(r.tools.map(t => t.name)).toEqual(['kb_get'])
    expect(r.errors).toHaveLength(9)
    expect(parseManifest('мусор', 'shef.mcp.tools', new Set()).tools).toEqual([])
  })
  it('схема с $ref — отказ; текст для модели без управляющих и bidi; заголовок в одну строку', () => {
    expect(parseManifest([{ ...ok, input: { type: 'object', properties: { a: { $ref: '#' } } } }], 'shef.mcp.tools', new Set()).tools).toEqual([])
    const r = parseManifest([{ ...ok, description: 'Статья\u202Eтайно\u0007', title: 'А\nБ' }], 'shef.mcp.tools', new Set())
    expect(r.tools[0]).toMatchObject({ description: 'Статьятайно', title: 'А Б' })
  })
  it('аргументы методу — только из схемы, без служебных', async () => {
    const { pickArgs } = await import('../server/lib/manifest')
    expect(pickArgs({ type: 'object', properties: { id: {}, auth: {}, _x: {} } }, { id: 1, auth: 'a', _x: 1, start: 50 })).toEqual({ id: 1 })
  })
  it('удаление — опасное, запись — не только чтение', () => {
    expect(annotationsFor('delete')).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(annotationsFor('write')).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })
  it('MODULE_MANIFESTS и WRITE_USERS', () => {
    expect(loadConfig({ ...env, MODULE_MANIFESTS: 'shef.mcp.tools, ' }).moduleManifests).toEqual(['shef.mcp.tools'])
    expect(() => loadConfig({ ...env, MODULE_MANIFESTS: 'tools' })).toThrow(/MODULE_MANIFESTS/)
    expect(loadConfig(env).canWrite({ host: 'b24.example', memberId: 'm0123456789', userId: 1 })).toBe(false)
    expect(loadConfig({ ...env, WRITE_USERS: '1' }).canWrite({ host: 'b24.example', memberId: 'm0123456789', userId: 1 })).toBe(true)
  })
})

describe('icon', () => {
  it('своя из каталога — первый найденный файл; нет или слишком большой — встроенная', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadIcon, DEFAULT_ICON } = await import('../server/lib/icon')
    const dir = mkdtempSync(join(tmpdir(), 'icon-'))
    expect(await loadIcon(dir)).toBe(DEFAULT_ICON)
    writeFileSync(join(dir, 'icon.svg'), '<svg/>')
    expect((await loadIcon(dir)).type).toBe('image/svg+xml')
    writeFileSync(join(dir, 'icon.png'), Buffer.from([0x89, 0x50]))
    expect((await loadIcon(dir)).type).toBe('image/png')
    writeFileSync(join(dir, 'icon.png'), Buffer.alloc(600 * 1024))
    expect((await loadIcon(dir)).type).toBe('image/svg+xml')
  })
})
