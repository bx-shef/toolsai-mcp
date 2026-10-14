// Боевой транспорт (b24jssdk) против маленького портала: проверяем то, что SDK теряет.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { B24Error, sdkTransport } from '../server/lib/b24'
import { loadConfig } from '../server/lib/config'

let url = ''
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* тело не нужно */ }
  const method = new URL(req.url!, 'http://x').pathname.slice(6).replace(/\.json$/, '')
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
})
