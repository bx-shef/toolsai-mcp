// Сквозной тест СОБРАННОГО сервера (.output, сначала `npm run build`) против подставного Битрикс24:
// метаданные → регистрация клиента → вход через портал → наш токен → инструмент от имени сотрудника.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS helper
import { startFakeB24 } from './fake-b24.mjs'

const PORT = 3911
const BASE = `http://127.0.0.1:${PORT}`
const REDIRECT = 'http://localhost:6274/callback'
let app: ChildProcess
let fake: any
let logs = ''

function start(extraEnv: Record<string, string> = {}) {
  app = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      B24_PORTAL_URL: fake.url,
      B24_OAUTH_SERVERS: fake.url,
      B24_CLIENT_ID: 'local.test',
      B24_CLIENT_SECRET: 'sec',
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ...extraEnv,
    },
  })
  app.stdout!.on('data', d => { logs += d })
  app.stderr!.on('data', d => { logs += d })
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return
    }
    catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`server did not start:\n${logs}`)
}

const b64url = (b: Buffer) => b.toString('base64url')

/** Полный вход, как у claude.ai. */
async function login(redirect = REDIRECT) {
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'test', redirect_uris: [redirect] }),
  })).json()
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const auth = new URL(`${BASE}/oauth/authorize`)
  for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st1' })) auth.searchParams.set(k, v)
  const r1 = await fetch(auth, { redirect: 'manual' })
  expect(r1.status).toBe(302)
  const portal = new URL(r1.headers.get('location')!)
  expect(portal.origin + portal.pathname).toBe(`${fake.url}/oauth/authorize/`)
  expect(portal.searchParams.get('client_id')).toBe('local.test')
  // портал впускает сотрудника и возвращает на наш callback
  const cb = new URL(`${BASE}/oauth/callback`)
  cb.searchParams.set('code', `b24code-${Math.random()}`)
  cb.searchParams.set('state', portal.searchParams.get('state')!)
  cb.searchParams.set('server_domain', new URL(fake.url).host)
  const r2 = await fetch(cb, { redirect: 'manual' })
  expect(r2.status).toBe(302)
  const back = new URL(r2.headers.get('location')!)
  return { reg, verifier, back }
}

async function token(params: Record<string, string>) {
  const r = await fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  return { status: r.status, body: await r.json() }
}

async function mcp(access: string | null, method: string, params: object = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...(access ? { authorization: `Bearer ${access}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = await r.text()
  const data = text.split('\n').find(l => l.startsWith('data: '))
  return { status: r.status, headers: r.headers, body: data ? JSON.parse(data.slice(6)) : (text ? JSON.parse(text) : null) }
}

async function fullToken() {
  const { reg, verifier, back } = await login()
  const t = await token({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier })
  expect(t.status).toBe(200)
  return { ...t.body, clientId: reg.client_id }
}

describe.skipIf(!existsSync('.output/server/index.mjs'))('e2e', () => {
  beforeAll(async () => {
    fake = await startFakeB24()
    start()
    await waitUp()
  })
  afterAll(() => {
    app?.kill()
    fake?.server.close()
  })

  it('без токена — 401 и адрес метаданных', async () => {
    const r = await mcp(null, 'tools/list')
    expect(r.status).toBe(401)
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource"`)
  })

  it('метаданные — и в корне, и со вставкой пути', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp-ai/mcp']) {
      const m = await (await fetch(BASE + p)).json()
      expect(m.resource).toBe(`${BASE}/mcp`)
      expect(m.authorization_servers).toEqual([BASE])
    }
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp-ai', '/.well-known/openid-configuration']) {
      const m = await (await fetch(BASE + p)).json()
      expect(m.issuer).toBe(BASE)
      expect(m.code_challenge_methods_supported).toEqual(['S256'])
    }
  })

  it('вход, токен и инструмент от имени сотрудника', async () => {
    const t = await fullToken()
    const list = await mcp(t.access_token, 'tools/list')
    expect(list.status).toBe(200)
    const names = list.body.result.tools.map((x: any) => x.name)
    expect(names).toEqual(expect.arrayContaining(['user_current', 'crm_deal_get', 'crm_deal_list', 'task_list']))
    for (const tool of list.body.result.tools) expect(tool.annotations?.readOnlyHint).toBe(true)

    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_deal_get', arguments: { id: 42 } })
    const out = JSON.parse(call.body.result.content[0].text)
    expect(out).toMatchObject({ ID: '42', _asUser: 7 })
    // REST ушёл токеном СОТРУДНИКА, а не общим
    const rest = fake.calls.filter((c: any) => c.path === '/rest/crm.deal.get.json').at(-1)
    expect(rest.body.auth).toMatch(/^at\d+$/)
    // журнал: имена аргументов, без значений
    expect(logs).toMatch(/"kind":"audit","user":7,"tool":"crm_deal_get","method":"crm.deal.get","args":\["id"\],"ok":true/)
  })

  it('код одноразовый, PKCE и redirect_uri проверяются', async () => {
    const { reg, verifier, back } = await login()
    const code = back.searchParams.get('code')!
    expect(back.searchParams.get('state')).toBe('st1')
    const bad = await token({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: b64url(randomBytes(32)) })
    expect(bad.body.error).toBe('invalid_grant')
    // неудачная попытка тоже сжигает код
    const again = await token({ grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: REDIRECT, code_verifier: verifier })
    expect(again.body.error).toBe('invalid_grant')
  })

  it('чужой redirect_uri — ошибка без редиректа', async () => {
    const reg = await (await fetch(`${BASE}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json()
    const r = await fetch(`${BASE}/oauth/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&response_type=code&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`, { redirect: 'manual' })
    expect(r.status).toBe(400)
    expect(r.headers.get('location')).toBeNull()
  })

  it('refresh вращается: старый не работает', async () => {
    const t = await fullToken()
    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })
    expect(r1.status).toBe(200)
    expect((await mcp(r1.body.access_token, 'tools/list')).status).toBe(200)
    const r2 = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })
    expect(r2.body.error).toBe('invalid_grant')
  })

  it('истёкший токен Битрикс24 обновляется сам', async () => {
    const t = await fullToken()
    fake.state.expireNext = true
    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_deal_get', arguments: { id: 5 } })
    expect(call.body.result.isError).not.toBe(true)
    expect(fake.calls.some((c: any) => c.path === '/oauth/token/' && c.query.grant_type === 'refresh_token')).toBe(true)
  })

  it('ошибка Битрикс24 — isError с кодом, не падение', async () => {
    const t = await fullToken()
    const call = await mcp(t.access_token, 'tools/call', { name: 'task_get', arguments: { id: 1 } })
    expect(call.body.result.isError).toBe(true)
    expect(call.body.result.content[0].text).toContain('ERROR_METHOD_NOT_FOUND')
  })

  it('ALLOWED_USERS: сотрудник не в списке — access_denied клиенту', async () => {
    app.kill()
    await new Promise(r => setTimeout(r, 300))
    start({ ALLOWED_USERS: '1' })
    await waitUp()
    const { back } = await login()
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
  })
})
