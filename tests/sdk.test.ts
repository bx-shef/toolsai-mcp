// Боевой транспорт (b24jssdk) против маленького портала: проверяем то, что SDK теряет.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { B24Error, portalText, sdkTransport } from '../server/lib/b24'
import { cleanText } from '../server/lib/manifest'
import { loadConfig } from '../server/lib/config'

let url = ''
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* тело не нужно */ }
  const method = new URL(req.url!, 'http://x').pathname.slice(6).replace(/\.json$/, '')
  if (method === 'shef.x.create') {
    // отказ модуля: код и текст для модели
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'INVALID_ARG_VALUE', error_description: 'Выберите сотрудников или отделы.' }))
    return
  }
  res.writeHead(method === 'crm.deal.get' ? 400 : 200, { 'content-type': 'application/json' })
  // Ровно как отвечает портал на отсутствующую запись (замер 2026-10-13)
  res.end(JSON.stringify(method === 'crm.deal.get' ? { error: '', error_description: 'Not found' } : { result: [{ ID: '1' }], next: 50, total: 120 }))
})
beforeAll(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => { url = `http://127.0.0.1:${(server.address() as any).port}`; r() })))
afterAll(() => { server.close() })

const transport = () => sdkTransport(loadConfig({
  PUBLIC_URL: 'https://mcp.example.by', B24_OAUTH_SERVERS: url,
  B24_CLIENT_ID: 'a', B24_CLIENT_SECRET: 'b', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), ALLOWED_USERS: '*',
} as never))
const ctx = { get endpoint() { return `${url}/rest/` }, access: 'at', refresh: async () => 'at2' }

describe('sdkTransport', () => {
  it('пустой код портала с «Not found» — NOT_FOUND, а не ERR_BAD_REQUEST', async () => {
    const e = await transport()(ctx, 'crm.deal.get', { id: 9 }).catch(x => x)
    expect(e).toBeInstanceOf(B24Error)
    expect(e.code).toBe('NOT_FOUND')
  })
  it('список: total и следующее смещение', async () => {
    const r = await transport()(ctx, 'crm.deal.list', { start: 0 })
    expect(r.total).toBe(120)
    expect(r.next).toBe(50)
  })
  it('отказ модуля через SDK: статус 4xx и код портала — текст для модели есть', async () => {
    const e = await transport()(ctx, 'shef.x.create', {}).catch(x => x)
    expect([e.code, e.status]).toEqual(['INVALID_ARG_VALUE', 400])
    expect(portalText(e)).toBe('Выберите сотрудников или отделы.')
  })
  it('сетевой сбой через SDK — только код, без адреса', async () => {
    const dead = { endpoint: 'http://127.0.0.1:1/rest/', access: 'at', refresh: async () => 'at2' }
    const e = await transport()(dead, 'shef.x.create', {}).catch(x => x)
    expect(e).toBeInstanceOf(B24Error)
    expect(portalText(e)).toBe('')
  })
})

describe('portalText', () => {
  it('только ответ портала 4xx с его кодом', () => {
    expect(portalText(new B24Error('INVALID_ARG_VALUE', 'Нет id', 400))).toBe('Нет id')
    expect(portalText(new B24Error('insufficient_scope', 'нужна область', 403))).toBe('нужна область')
    expect(portalText(new B24Error('ACCESS_DENIED', 'ACCESS_DENIED', 403))).toBe('')
    expect(portalText(new B24Error('INVALID_ARG_VALUE', 'Нет id', 500))).toBe('')
    expect(portalText(new B24Error('portal_private', 'Адрес портала x.local ведёт во внутреннюю сеть', 0))).toBe('')
    for (const code of ['network_error', 'JSSDK_INTERNAL_AJAX_ERROR', 'ERR_BAD_REQUEST', 'http_404', 'bad_method', 'refresh_failed', 'ECONNREFUSED x']) {
      expect(portalText(new B24Error(code, 'connect ECONNREFUSED 10.0.0.5:443', 400))).toBe('')
    }
  })
})

describe('cleanText', () => {
  it('невидимые символы прочь, эмодзи на границе не рвётся', () => {
    expect(cleanText('a\u0085b\u00ADc\u{E0041}d\u202Ee', 100)).toBe('abcde')
    expect(cleanText('ab😀', 3)).toBe('ab😀')
  })
})
