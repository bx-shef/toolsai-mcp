// Сквозной тест СОБРАННОГО сервера (.output, сначала `npm run build`) против подставного Битрикс24:
// метаданные → регистрация клиента → вход через портал → наш токен → инструмент от имени сотрудника.
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
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
      B24_OAUTH_SERVERS: fake.url,
      B24_CLIENT_ID: 'local.test',
      B24_CLIENT_SECRET: 'sec',
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ALLOWED_USERS: '*',
      MODULE_MANIFESTS: 'shef.mcp.tools',
      BRANDING_DIR: '/nonexistent-branding',
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

async function register(redirect = REDIRECT) {
  return (await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'test', redirect_uris: [redirect] }),
  })).json()
}

/** До экрана согласия: возвращает txn и cookie браузера, начавшего вход. */
async function startLogin(reg: any, redirect = REDIRECT) {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const auth = new URL(`${BASE}/oauth/authorize`)
  for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st1' })) auth.searchParams.set(k, v)
  const r = await fetch(auth, { redirect: 'manual' })
  expect(r.status).toBe(200)
  const html = await r.text()
  expect(html).toContain('test')
  expect(html).toContain(new URL(redirect).host)
  expect(r.headers.get('x-frame-options')).toBe('DENY')
  // form-action ломает цепочку редиректов в Chrome: портал → callback → redirect_uri клиента (2026-10-16)
  expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  expect(r.headers.get('content-security-policy')).not.toContain('form-action')
  const txn = /name="txn" value="([^"]+)"/.exec(html)![1]!
  const setCookie = r.headers.get('set-cookie')!
  expect(setCookie).toMatch(/HttpOnly/i)
  expect(setCookie).toMatch(/SameSite=Lax/i)
  const cookie = setCookie.split(';')[0]!
  return { verifier, txn, cookie }
}

async function consent(txn: string, cookie: string | null, decision = 'allow') {
  return fetch(`${BASE}/oauth/consent`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ txn, decision, portal: 'test.bitrix24.by' }),
  })
}

async function portalReturn(state: string, cookie: string | null, code = `b24code-${Math.random()}`) {
  const cb = new URL(`${BASE}/oauth/callback`)
  cb.searchParams.set('code', code)
  cb.searchParams.set('state', state)
  cb.searchParams.set('server_domain', new URL(fake.url).host)
  return fetch(cb, { redirect: 'manual', headers: cookie ? { cookie } : {} })
}

/** Полный вход, как у claude.ai: согласие, портал, возврат клиенту. */
async function login(redirect = REDIRECT, code?: string) {
  const reg = await register(redirect)
  const { verifier, txn, cookie } = await startLogin(reg, redirect)
  const r1 = await consent(txn, cookie)
  expect(r1.status).toBe(303)
  const portal = new URL(r1.headers.get('location')!)
  expect(portal.origin + portal.pathname).toBe('https://test.bitrix24.by/oauth/authorize/')
  expect(portal.searchParams.get('client_id')).toBe('local.test')
  // портал впускает сотрудника и возвращает на наш callback — в том же браузере, с cookie
  const r2 = await portalReturn(portal.searchParams.get('state')!, cookie, code)
  expect(r2.status).toBe(302)
  // cookie входа сбрасывается на том же пути, где была поставлена (иначе браузер её не удалит)
  expect(r2.headers.get('set-cookie')).toMatch(/mcp_login=;.*Path=\/oauth/i)
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

// В CI сборка обязательна: без .output тест не пропускается молча, а падает.
describe.skipIf(!process.env.CI && !existsSync('.output/server/index.mjs'))('e2e', () => {
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
    expect(names).toEqual(expect.arrayContaining(['user_current', 'crm_item_get', 'crm_item_list', 'crm_fields', 'crm_stages', 'task_list']))
    // без права записи — только чтение; исключение — свой рабочий день
    for (const tool of list.body.result.tools) if (tool.name !== 'worktime_action') expect(tool.annotations?.readOnlyHint).toBe(true)

    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_item_get', arguments: { entity: 'deal', id: 42 } })
    const out = JSON.parse(call.body.result.content[0].text)
    expect(out).toMatchObject({ id: 42, _asUser: 7 })
    // REST ушёл токеном СОТРУДНИКА, а не общим
    const rest = fake.calls.filter((c: any) => /^\/rest\/crm\.item\.get(\.json)?$/.test(c.path)).at(-1)
    expect(rest.body).toMatchObject({ entityTypeId: 2, id: 42, auth: expect.stringMatching(/^at\d+$/) })
    // журнал: имена аргументов, без значений
    expect(logs).toMatch(/"kind":"audit","portal":"localhost","member":"fake0member1","user":7,"tool":"crm_item_get","method":"crm.item.get","args":\["entity","id"\],"ok":true/)
  })

  it('подсказка портала в authorize — в поле согласия; мусор — не подставляется', async () => {
    const reg = await register(REDIRECT)
    const page = async (portal: string) => {
      const auth = new URL(`${BASE}/oauth/authorize`)
      for (const [k, v] of Object.entries({ client_id: reg.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', portal })) auth.searchParams.set(k, v)
      return (await fetch(auth)).text()
    }
    expect(await page('https://box.example.by/crm/')).toContain('name="portal" value="box.example.by"')
    expect(await page('"><script>')).not.toContain('<script>')
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

  it('подмена входа: ссылка на портал, открытая в чужом браузере, кода не даёт', async () => {
    // атакующий начал вход своим клиентом и прислал сотруднику ссылку на портал
    const reg = await register('https://evil.example/cb')
    const { txn, cookie } = await startLogin(reg, 'https://evil.example/cb')
    // без cookie браузера-инициатора согласие не принимается
    expect((await consent(txn, null)).status).toBe(403)
    // атакующий сам согласился в своём браузере, а на портал по ссылке зашёл сотрудник — у него нет cookie
    const ok = await consent(txn, cookie)
    const state = new URL(ok.headers.get('location')!).searchParams.get('state')!
    const r = await portalReturn(state, null)
    expect(r.status).toBe(403)
    expect(r.headers.get('location')).toBeNull()
    // и чужая cookie не подходит
    const other = await startLogin(await register())
    expect((await portalReturn(state, other.cookie)).status).toBe(403)
  })

  it('отказ на экране согласия — клиенту access_denied со state', async () => {
    const { txn, cookie } = await startLogin(await register())
    const r = await consent(txn, cookie, 'deny')
    const back = new URL(r.headers.get('location')!)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('state')).toBe('st1')
  })

  it('портал не выдал токены — клиенту server_error редиректом, не JSON в браузер', async () => {
    const { back } = await login(REDIRECT, 'b24code-fail')
    expect(back.origin).toBe('http://localhost:6274')
    expect(back.searchParams.get('error')).toBe('server_error')
    expect(back.searchParams.get('state')).toBe('st1')
  })

  it('без согласия на портал не пускает', async () => {
    const { txn, cookie } = await startLogin(await register())
    // согласия не было — возврат с портала не принимается
    expect((await portalReturn(txn, cookie)).status).toBe(400)
  })

  it('чужой redirect_uri — ошибка без редиректа', async () => {
    const reg = await register()
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
    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_item_get', arguments: { entity: 'deal', id: 5 } })
    expect(call.body.result.isError).not.toBe(true)
    expect(fake.calls.some((c: any) => c.path === '/oauth/token/' && c.query.grant_type === 'refresh_token')).toBe(true)
  })

  it('списки отдают next и total', async () => {
    const t = await fullToken()
    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_item_list', arguments: { entity: 'deal', start: 50 } })
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({ items: [{ id: 51 }], next: 100, total: 120 })
    const tasks = await mcp(t.access_token, 'tools/call', { name: 'task_list', arguments: {} })
    expect(JSON.parse(tasks.body.result.content[0].text)).toMatchObject({ tasks: [{ id: '1' }], next: null, total: 1 })
  })

  it('список CRM отдаёт имена ответственных и названия стадий', async () => {
    const t = await fullToken()
    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_item_list', arguments: { entity: 'deal', filter: { '@id': [3, 4] } } })
    const out = JSON.parse(call.body.result.content[0].text)
    expect(out.users).toEqual({ 1: 'Имя1 Фамилия' })
    expect(out.items).toHaveLength(2)
  })

  it('портал отозвал вход — наш токен и refresh перестают работать, клиент войдёт заново', async () => {
    const t = await fullToken()
    fake.state.revoked = true
    try {
      const call = await mcp(t.access_token, 'tools/call', { name: 'crm_item_get', arguments: { entity: 'deal', id: 1 } })
      expect(call.body.result.isError).toBe(true)
      expect((await mcp(t.access_token, 'tools/list')).status).toBe(401)
      const r = await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId })
      expect(r.body.error).toBe('invalid_grant')
    }
    finally {
      fake.state.revoked = false
    }
  })

  it('ошибка Битрикс24 — isError с кодом, не падение', async () => {
    const t = await fullToken()
    const call = await mcp(t.access_token, 'tools/call', { name: 'crm_item_get', arguments: { entity: 'lead', id: 1 } })
    expect(call.body.result.isError).toBe(true)
    expect(call.body.result.content[0].text).toContain('ERROR_METHOD_NOT_FOUND')
  })

  it('нет записи — понятное «не найдено», ID строкой принимается', async () => {
    const t = await fullToken()
    const text = async (name: string, args: object) => (await mcp(t.access_token, 'tools/call', { name, arguments: args })).body.result
    const deal = await text('crm_item_get', { entity: 'deal', id: 404 })
    expect(deal.isError).toBe(true)
    expect(deal.content[0].text).toContain('Не найдено')
    const task = await text('task_get', { id: '404' })
    expect(task.isError).toBe(true)
    expect(task.content[0].text).toContain('Не найдено')
    const ok = await text('task_get', { id: '9' })
    expect(JSON.parse(ok.content[0].text)).toEqual({ id: '9' })
  })

  it('сбой манифеста не кешируется: следующий запрос получает инструменты модуля', async () => {
    fake.state.user = 8 // свой сотрудник — свой кеш манифеста
    fake.state.manifestFail = true
    const t = await fullToken()
    fake.state.user = 7
    const names = async () => (await mcp(t.access_token, 'tools/list')).body.result.tools.map((x: any) => x.name)
    expect(await names()).not.toContain('kb_search')
    expect(await names()).toContain('kb_search')
  })

  it('инструменты модуля: из манифеста, только своего вендора, запись — только WRITE_USERS', async () => {
    const t = await fullToken()
    const list = await mcp(t.access_token, 'tools/list')
    const tools = Object.fromEntries(list.body.result.tools.map((x: any) => [x.name, x]))
    expect(tools.kb_search.annotations.readOnlyHint).toBe(true)
    expect(tools.kb_search.inputSchema.required).toEqual(['query'])
    expect(tools.kb_delete).toBeUndefined() // WRITE_USERS не задан
    expect(tools.evil).toBeUndefined() // crm.deal.delete — не метод модуля
    expect(tools.crm_item_get.description).not.toContain('перекрыть')
    const call = await mcp(t.access_token, 'tools/call', { name: 'kb_search', arguments: { query: 'отпуск' } })
    expect(JSON.parse(call.body.result.content[0].text)).toMatchObject({ result: [{ title: 'Статья про отпуск', _asUser: 7 }], total: 1 })
    const rest = fake.calls.filter((c: any) => /^\/rest\/shef\.kb\.search/.test(c.path)).at(-1)
    expect(rest.body).toMatchObject({ query: 'отпуск', auth: expect.stringMatching(/^at\d+$/) })
    // лишние ключи до портала не доходят
    await mcp(t.access_token, 'tools/call', { name: 'kb_search', arguments: { query: 'x', filter: { ID: 1 }, start: 50 } })
    const rest2 = fake.calls.filter((c: any) => /^\/rest\/shef\.kb\.search/.test(c.path)).at(-1)
    expect(Object.keys(rest2.body).sort()).toEqual(['auth', 'query'])
    // схема из манифеста проверяется до портала
    const bad = await mcp(t.access_token, 'tools/call', { name: 'kb_search', arguments: { limit: 500 } })
    expect(bad.body.result.isError).toBe(true)
    expect(logs).toMatch(/"tool":"module:kb_search","method":"shef.kb.search","args":\["query"\],"ok":true/)
  })

  it('иконка коннектора: в initialize полный адрес, файл отдаётся', async () => {
    const t = await fullToken()
    const init = await mcp(t.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    // своей иконки в тесте нет (BRANDING_DIR — пустой каталог) — встроенная
    expect(init.body.result.serverInfo.icons).toEqual([{ src: `${BASE}/icon`, mimeType: 'image/svg+xml', sizes: ['any'] }])
    const icon = await fetch(`${BASE}/icon`)
    expect(icon.status).toBe(200)
    expect(icon.headers.get('content-type')).toContain('image/svg+xml')
    expect(await icon.text()).toContain('<svg')
    // HEAD — тот же тип (проверка curl -I), прочие методы — 405
    expect((await fetch(`${BASE}/icon`, { method: 'HEAD' })).headers.get('content-type')).toContain('image/svg+xml')
    expect((await fetch(`${BASE}/icon`, { method: 'POST' })).status).toBe(405)
  })

  it('/health не выдаёт внутренние подробности', async () => {
    const h = await (await fetch(`${BASE}/health`)).json()
    expect(Object.keys(h).sort()).toEqual(['commit', 'ready', 'status'])
  })

  it('WRITE_USERS: сотруднику открыто — инструмент удаления виден и помечен опасным', async () => {
    app.kill()
    await new Promise(r => setTimeout(r, 300))
    start({ WRITE_USERS: 'member:fake0member1:7' })
    await waitUp()
    const t = await fullToken()
    const tools = Object.fromEntries((await mcp(t.access_token, 'tools/list')).body.result.tools.map((x: any) => [x.name, x]))
    expect(tools.kb_delete.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  })

  it('ALLOWED_USERS: сотрудник не в списке — access_denied клиенту', async () => {
    app.kill()
    await new Promise(r => setTimeout(r, 300))
    start({ ALLOWED_USERS: 'other.bitrix24.by' })
    await waitUp()
    const { back } = await login()
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
  })

  it('/admin: администратор портала открывает доступ кодами Битрикс24 — без .env', async () => {
    app.kill()
    await new Promise(r => setTimeout(r, 300))
    start({ ALLOWED_USERS: '', MODULE_MANIFESTS: '' })
    await waitUp()
    // ничего не настроено: сотрудник 7 не администратор — отказ
    fake.state.user = 7
    expect((await login()).back.searchParams.get('error')).toBe('access_denied')

    /** Вход на страницу настроек: форма → портал → возврат → cookie сессии. */
    const adminLogin = async () => {
      const r = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'portal=test.bitrix24.by' })
      expect(r.status).toBe(303)
      const state = new URL(r.headers.get('location')!).searchParams.get('state')!
      expect(state.startsWith('adm.')).toBe(true)
      const cookie = r.headers.getSetCookie().find(c => c.startsWith('mcp_admin_login='))!.split(';')[0]!
      return portalReturn(state, cookie)
    }
    // не администратор на настройки не попадает
    const denied = await adminLogin()
    expect(denied.status).toBe(403)
    expect(await denied.text()).toContain('только администратору')

    fake.state.user = 1
    const ok = await adminLogin()
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toBe(`${BASE}/admin`)
    const sess = ok.headers.getSetCookie().find(c => c.startsWith('mcp_admin='))!
    expect(sess).toMatch(/HttpOnly/i)
    expect(sess).toMatch(/Path=\/admin/i)
    const cookie = sess.split(';')[0]!
    const page = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text()
    expect(page).toContain('Портал <b>localhost</b>') // портал — из ответа OAuth-сервера, не из формы
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!
    const save = (form: Record<string, string>) => fetch(`${BASE}/admin/save`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })
    // чужая форма без csrf — отказ; мусор вместо кодов — отказ, ничего не сохранено
    expect((await save({ csrf: 'x', use: 'U7' })).status).toBe(403)
    expect((await save({ csrf, use: 'ivanov' })).status).toBe(400)
    const all = { group_crm: '1', group_tasks: '1', group_calendar: '1', group_kb: '1', group_messages: '1', group_worktime: '1', group_disk: '1', group_catalog: '1', group_calls: '1', group_modules: '1' }
    const saved = await save({ csrf, use: 'U7', write: '', manifests: 'shef.mcp.tools', ...all })
    expect(saved.status).toBe(200)
    expect(await saved.text()).toContain('Сохранено')
    expect(logs).toMatch(/"kind":"admin".*"action":"settings","disabled":false,"groupsOff":\[\],"use":1,"write":0,"manifests":1/)

    // сотрудник 7 входит; модули — из настроек, запись — только администраторам
    fake.state.user = 7
    const t = await fullToken()
    const tools = Object.fromEntries((await mcp(t.access_token, 'tools/list')).body.result.tools.map((x: any) => [x.name, x]))
    expect(tools.kb_search).toBeDefined()
    expect(tools.kb_delete).toBeUndefined()
    const acc = fake.calls.filter((c: any) => c.path.startsWith('/rest/user.access')).at(-1)
    expect(acc.body.ACCESS).toEqual(['U7'])
    // сотрудник 8 не в кодах
    fake.state.user = 8
    expect((await login()).back.searchParams.get('error')).toBe('access_denied')

    // выключенная группа пропадает у всех — и чтение, и запись
    expect((await save({ csrf, use: 'U7', manifests: 'shef.mcp.tools', ...all, group_crm: '' })).status).toBe(200)
    fake.state.user = 1
    const adm = await fullToken()
    const names = (await mcp(adm.access_token, 'tools/list')).body.result.tools.map((x: any) => x.name)
    expect(names.filter((n: string) => n.startsWith('crm_'))).toEqual([])
    expect(names).toContain('task_create')
    expect((await mcp(adm.access_token, 'tools/call', { name: 'crm_item_get', arguments: { entity: 'deal', id: 1 } })).body.result?.isError ?? true).toBe(true)
    // главный выключатель: закрыто всем, и администратору, и уже выданный токен перестаёт действовать
    expect((await save({ csrf, use: 'U7', manifests: 'shef.mcp.tools', ...all, disabled: '1' })).status).toBe(200)
    expect((await mcp(adm.access_token, 'tools/list')).status).toBe(401)
    expect((await login()).back.searchParams.get('error')).toBe('access_denied')
    // отказ входа забыл токены администратора — страница просит войти заново, а не «вы не администратор»
    const stale = await save({ csrf, use: 'U7', manifests: 'shef.mcp.tools', ...all })
    expect(stale.status).toBe(401)
    expect(await stale.text()).toContain('войдите заново')
    const again = (await adminLogin()).headers.getSetCookie().find(c => c.startsWith('mcp_admin='))!.split(';')[0]!
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(await (await fetch(`${BASE}/admin`, { headers: { cookie: again } })).text())![1]!
    // обратно: всё включено, как было
    expect((await fetch(`${BASE}/admin/save`, { method: 'POST', headers: { cookie: again, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: csrf2, use: 'U7', write: '', manifests: 'shef.mcp.tools', ...all }) })).status).toBe(200)
    fake.state.user = 7
  })

  it('календарь и задачи: события, занятость, чек-лист, время, комментарии из чата и форума', async () => {
    fake.state.user = 1 // администратор — проходит без настроек
    const t = await fullToken()
    const call = async (name: string, args: object) => {
      const r = await mcp(t.access_token, 'tools/call', { name, arguments: args })
      expect(r.body.result.isError, JSON.stringify(r.body)).toBeFalsy()
      return JSON.parse(r.body.result.content[0].text)
    }
    // свой календарь: ownerId из user.current
    expect((await call('calendar_events', { from: '2026-10-01', to: '2026-10-31' }))[0]).toMatchObject({ OWNER_ID: '1', CAL_TYPE: 'user' })
    expect((await mcp(t.access_token, 'tools/call', { name: 'calendar_events', arguments: { from: '1.10.2026', to: '2026-10-31' } })).body.result.isError).toBe(true)
    expect(await call('calendar_busy', { users: [1, 7], from: '2026-10-16', to: '2026-10-20' })).toEqual({ 1: [], 7: [] })
    expect((await call('task_checklist', { taskId: 18 }))[0].TASK_ID).toBe('18')
    expect((await call('task_elapsed', { taskId: 18 })).totalSeconds).toBe(900)
    const chat = await call('task_comments', { taskId: 18 })
    expect(chat).toMatchObject({ source: 'chat', messages: [{ text: 'готово', system: false }, { system: true }] })
    expect((await call('task_comments', { taskId: 5 })).source).toBe('forum')
    fake.state.user = 7
  })

  it('запись в задачи: видна только с правом записи, отвечает «было → стало»', async () => {
    fake.state.user = 7 // без права записи (настройки предыдущего теста: только U7 на вход)
    const plain = await fullToken()
    const names = (await mcp(plain.access_token, 'tools/list')).body.result.tools.map((x: any) => x.name)
    expect(names).not.toContain('task_create')
    // свой рабочий день — без права записи: меняет только состояние самого сотрудника
    const wt = await mcp(plain.access_token, 'tools/call', { name: 'worktime_action', arguments: { action: 'open' } })
    expect(JSON.parse(wt.body.result.content[0].text)).toEqual({ status: { было: 'CLOSED', стало: 'OPENED' }, start: 't0', finish: null })
    expect(JSON.parse((await mcp(plain.access_token, 'tools/call', { name: 'worktime_status', arguments: {} })).body.result.content[0].text).status).toBe('OPENED')
    fake.state.user = 1 // администратор портала пишет всегда
    const t = await fullToken()
    const tools = Object.fromEntries((await mcp(t.access_token, 'tools/list')).body.result.tools.map((x: any) => [x.name, x]))
    expect(tools.task_update.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    const call = async (name: string, args: object) => {
      const r = await mcp(t.access_token, 'tools/call', { name, arguments: args })
      expect(r.body.result.isError, JSON.stringify(r.body)).toBeFalsy()
      return JSON.parse(r.body.result.content[0].text)
    }
    expect(await call('task_create', { title: 'Отчёт', crm: ['D_12'] })).toMatchObject({ id: 30, responsibleId: 1, status: 'ждёт выполнения' })
    expect(fake.calls.filter((c: any) => c.path.startsWith('/rest/tasks.task.add')).at(-1).body.fields).toMatchObject({ TITLE: 'Отчёт', RESPONSIBLE_ID: '1', UF_CRM_TASK: ['D_12'] })
    // подзадача: PARENT_ID уходит в портал, parentId — в ответе (замер 2026-10-17)
    expect(await call('task_create', { title: 'Шаг 1', parentId: 12 })).toMatchObject({ id: 30, parentId: 12 })
    expect(fake.calls.filter((c: any) => c.path.startsWith('/rest/tasks.task.add')).at(-1).body.fields.PARENT_ID).toBe(12)
    expect(await call('task_update', { taskId: 30, title: 'Стало' })).toEqual({ taskId: 30, changes: { title: { было: 'Было', стало: 'Стало' } } })
    expect(await call('task_status', { taskId: 30, action: 'start' })).toEqual({ taskId: 30, status: { было: 'ждёт выполнения', стало: 'выполняется' } })
    expect(await call('task_time_add', { taskId: 30, minutes: 30, comment: 'сделано' })).toEqual({ taskId: 30, recordId: 5, minutes: 30 })
    expect(await call('task_checklist_done', { taskId: 30, itemId: 4, done: false })).toMatchObject({ done: false })
    expect(fake.calls.at(-1).path).toMatch(/task\.checklistitem\.renew/)
    // комментарий — в чат задачи по REST v3; на старой коробке — прежним способом
    expect(await call('task_comment_add', { taskId: 30, text: 'итог' })).toEqual({ taskId: 30, sent: true, via: 'chat' })
    expect(fake.calls.at(-1)).toMatchObject({ path: '/rest/api/tasks.task.chat.message.send', body: { fields: { taskId: 30, text: 'итог' } } })
    fake.state.oldBox = true
    expect(await call('task_comment_add', { taskId: 30, text: 'итог' })).toEqual({ taskId: 30, sent: true, via: 'forum', commentId: 88 })
    fake.state.oldBox = false
    expect(await call('task_result_add', { taskId: 30, text: 'сделано' })).toEqual({ taskId: 30, resultId: 2, createdAt: 'd' })
    // встреча: владелец — сам сотрудник, он же среди участников
    expect(await call('calendar_event_add', { name: 'Созвон', from: '2026-10-20T10:00:00', to: '2026-10-20T11:00:00', attendees: [7] })).toEqual({ eventId: 9 })
    expect(fake.calls.at(-1).body).toMatchObject({ type: 'user', ownerId: 1, attendees: [1, 7], host: 1, timezone_from: 'Europe/Minsk' })
    const empty = await mcp(t.access_token, 'tools/call', { name: 'task_update', arguments: { taskId: 30 } })
    expect(empty.body.result.isError).toBe(true)
    // журнал — без значений
    expect(logs).toMatch(/"tool":"task_update","method":"tasks.task.update","args":\["taskId","title"\],"ok":true/)
    expect(logs).not.toContain('Стало')
    fake.state.user = 7
  })

  it('база знаний: только REST v3 — базы, оглавление, поиск, статья; запись — с правом записи', async () => {
    fake.state.user = 1
    const t = await fullToken()
    const call = async (name: string, args: object) => {
      const r = await mcp(t.access_token, 'tools/call', { name, arguments: args })
      return { err: r.body.result.isError, data: r.body.result.isError ? r.body.result.content[0].text : JSON.parse(r.body.result.content[0].text) }
    }
    expect((await call('note_bases', {})).data).toEqual([{ id: 1, name: 'Моя компания', policyLevel: 'portal' }])
    expect(fake.calls.filter((c: any) => c.path.startsWith('/rest/')).at(-1).path).toBe('/rest/api/note.collection.list')
    expect((await call('note_tree', { collectionId: 1 })).data).toEqual({ items: [{ id: 3, title: 'Отпуск', children: [{ id: 4, title: 'Заявление' }] }], truncated: false })
    expect((await call('note_search', { query: 'отпуск' })).data.items[0]).toEqual({ id: 3, collectionId: 1, title: 'Отпуск', snippet: 'Как оформить отпуск' })
    expect((await call('note_search', { query: 'ab' })).err).toBe(true) // от 3 символов — до портала
    expect((await call('note_get', { id: 3 })).data).toMatchObject({ title: 'Отпуск', markdown: '# Отпуск\nТекст', archived: false })
    const missing = await call('note_get', { id: 99 })
    expect(missing.err).toBe(true)
    expect(missing.data).toContain('Не найдено')
    expect((await call('note_add', { collectionId: 1, title: 'Новая', markdown: 'x' })).data).toEqual({ id: 5, collectionId: 1, title: 'Новая' })
    expect((await call('note_update', { id: 3, markdown: 'короче' })).data).toEqual({ id: 3, changes: { markdown: { было: '14 символов', стало: '6 символов' } } })
    fake.state.user = 7
    const plain = await fullToken()
    const names = (await mcp(plain.access_token, 'tools/list')).body.result.tools.map((x: any) => x.name)
    expect(names).toContain('note_search')
    expect(names).not.toContain('note_add')
  })

  it('CRM через crm.item.*: поля, стадии, изменение «было → стало» только известных полей', async () => {
    fake.state.user = 1
    const t = await fullToken()
    const call = async (name: string, args: object) => {
      const r = await mcp(t.access_token, 'tools/call', { name, arguments: args })
      return { err: r.body.result.isError, data: r.body.result.isError ? r.body.result.content[0].text : JSON.parse(r.body.result.content[0].text) }
    }
    const fields = (await call('crm_fields', { entity: 'deal' })).data
    expect(fields).toContainEqual({ code: 'id', title: 'ID', type: 'integer', readOnly: true })
    expect(fields).toContainEqual({ code: 'ufCrmList', title: 'Список', type: 'enumeration', items: [{ id: 1, value: 'А' }] })
    // воронки и стадии: общая — DEAL_STAGE, другая — DEAL_STAGE_<id>
    expect((await call('crm_stages', { entity: 'deal' })).data).toEqual([
      { categoryId: 0, name: 'Общая', stages: [{ id: 'NEW', name: 'Новая', semantics: 'process' }] },
      { categoryId: 3, name: 'Опт', stages: [{ id: 'C3:NEW', name: 'Новая', semantics: 'process' }] },
    ])
    // смарт-процесс — по ID типа
    await call('crm_item_get', { entity: 1044, id: 5 })
    expect(fake.calls.at(-1).body).toMatchObject({ entityTypeId: 1044, id: 5 })
    expect(await call('crm_item_update', { entity: 'deal', id: 5, fields: { stageId: 'WON', post: 'Директор' } })).toEqual({ err: undefined, data: { entityTypeId: 2, id: 5, changes: { stageId: { было: 'NEW', стало: 'WON' }, post: { было: null, стало: 'Директор' } } } })
    // неизвестное и только для чтения — отказ до портала
    const updates = () => fake.calls.filter((c: any) => c.path.startsWith('/rest/crm.item.update')).length
    const n = updates()
    const bad = await call('crm_item_update', { entity: 'deal', id: 5, fields: { id: 9, bogus: 1 } })
    expect(bad.err).toBe(true)
    expect(bad.data).toContain('id, bogus')
    expect(updates()).toBe(n)
    expect((await call('crm_item_add', { entity: 'contact', fields: { title: 'Новый' } })).data).toEqual({ entityTypeId: 3, id: 77, title: 'Новый' })
    // поиск по телефону: найденные с названиями, недоступная сотруднику — только id
    expect((await call('crm_find', { phone: ['+375297778899'] })).data).toEqual({ found: [
      { entity: 'contact', id: 46, title: 'К46', assignedById: 1 }, { entity: 'contact', id: 48, title: 'К48', assignedById: 1 }, { entity: 'company', id: 9, hidden: true },
    ], duplicates: true })
    expect((await call('crm_find', { email: ['nobody@example.com'] })).data).toEqual({ found: [], duplicates: false })
    expect((await call('crm_find', {})).err).toBe(true)
    // сообщения: чаты и отправка; неверный адресат — отказ до портала
    expect((await call('im_chats', {})).data).toEqual([{ dialogId: '8', type: 'user', title: 'Пётр' }, { dialogId: 'chat2', type: 'chat', title: 'Общий чат' }])
    expect((await call('im_message_send', { dialogId: 'chat2', text: 'Дайджест' })).data).toEqual({ dialogId: 'chat2', messageId: 136 })
    expect((await call('im_message_send', { dialogId: 'all', text: 'x' })).err).toBe(true)
    expect((await call('im_message_send', { dialogId: 'chat999', text: 'x' })).data).toContain('CHAT_ID')
    expect(logs).not.toContain('Дайджест')
    // Диск: ссылку на скачивание с токеном модель не получает
    expect((await call('disk_storages', {})).data).toEqual([{ id: 1, name: 'Мой', type: 'user', rootFolderId: 1 }])
    const folder = await call('disk_folder', { folderId: 1 })
    expect(folder.data.items[0]).toEqual({ id: 72, name: 'a.txt', type: 'file', size: 5, updatedBy: 1, updatedAt: 't', url: 'https://p/disk/72' })
    expect(JSON.stringify(folder.data)).not.toContain('SECRET')
    expect((await call('disk_folder_add', { parentId: 1, name: 'Счета' })).data).toEqual({ id: 70, name: 'Счета', parentId: 1 })
    expect((await call('disk_move', { id: 72, type: 'file', targetFolderId: 70 })).data).toEqual({ id: 72, name: 'a.txt', folder: { было: 1, стало: 70 } })
    // каталог: поиск в первом каталоге (iblockId обязателен у портала), карточка с ценами и остатками, описание
    expect((await call('catalog_products', { query: 'Окно' })).data).toEqual({ items: [{ id: 4, iblockId: 24, name: 'Окно', active: 'Y', quantity: 3 }], next: null, total: 1 })
    expect(fake.calls.filter((c: any) => c.path.startsWith('/rest/catalog.product.list')).at(-1).body.filter).toEqual({ iblockId: 24, '%name': 'Окно' })
    expect((await call('catalog_product_get', { id: 4 })).data).toMatchObject({ prices: [{ priceTypeId: 1, price: 100, currency: 'BYN' }], stores: [{ storeId: 1, amount: 3, reserved: 1 }] })
    expect((await call('catalog_product_update', { id: 4, detailText: 'Новое' })).data).toEqual({ id: 4, changes: { detailText: { было: 'старое', стало: 'Новое' } } })
    // документы: шаблоны по привязке «2_category_<воронка>», документ с ссылками на DOCX и PDF
    expect((await call('crm_doc_templates', { entity: 'deal' })).data).toEqual([{ id: 2, name: 'Акт', region: 'by' }])
    expect((await call('crm_doc_create', { templateId: 2, entity: 'deal', id: 40 })).data).toEqual({ documentId: 5, title: 'Акт 1', number: '1', downloadUrl: 'https://p/ajax.php?action=crm.documentgenerator.document.download&id=5', pdfUrl: 'https://p/ajax.php?action=crm.documentgenerator.document.getPdf&id=5' })
    expect(fake.calls.at(-1).body).toMatchObject({ templateId: 2, entityTypeId: 2, entityId: 40 })
    // звонки: период в фильтре, входящие — типы 2 и 3, сводка, запись разговора не отдаётся
    const calls = (await call('calls_stats', { from: '2026-10-01', to: '2026-10-17', type: 'incoming' })).data
    expect(fake.calls.at(-1).body.FILTER).toEqual({ '>=CALL_START_DATE': '2026-10-01T00:00:00', '<=CALL_START_DATE': '2026-10-17T23:59:59', CALL_TYPE: [2, 3] })
    expect(calls.summary).toEqual({ calls: 2, missed: 1, minutes: 2 })
    expect(calls.items[1]).toMatchObject({ ok: false, failed: 'Пропущенный', type: 'входящий' })
    expect(calls.items[0].crm).toEqual({ type: 'CONTACT', id: 5 })
    expect(JSON.stringify(calls)).not.toContain('SECRET')
    // значения полей в журнал не попадают
    expect(logs).not.toContain('Директор')
    fake.state.user = 7
  })

  it('лицензия: без неё инструменты отвечают 402, администратор ставит сертификат на /admin — работает', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64')
    app.kill()
    await new Promise(r => setTimeout(r, 300))
    start({ LICENSE_REQUIRED: '1', LICENSE_PUBLIC_KEYS: `t1:${raw}` })
    await waitUp()
    fake.state.user = 1
    const t = await fullToken()
    const denied = await mcp(t.access_token, 'tools/call', { name: 'user_current', arguments: {} })
    expect(denied.body.result.isError).toBe(true)
    expect(denied.body.result.content[0].text).toContain('Лицензия MCP')
    // администратор входит на /admin и вставляет сертификат, подписанный ключом сервера лицензий
    const r = await fetch(`${BASE}/admin/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'portal=test.bitrix24.by' })
    const back = await portalReturn(new URL(r.headers.get('location')!).searchParams.get('state')!, r.headers.getSetCookie().find(c => c.startsWith('mcp_admin_login='))!.split(';')[0]!)
    const cookie = back.headers.getSetCookie().find(c => c.startsWith('mcp_admin='))!.split(';')[0]!
    const page = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text()
    expect(page).toContain('<h2>Лицензия</h2>')
    expect(page).toContain('1200 BYN')
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!
    const now = Math.floor(Date.now() / 1000)
    const fp = createHash('sha256').update('bxl-fp-v1|install|fake0member1').digest('hex')
    const body = `BXL1.${Buffer.from(JSON.stringify({ v: 1, kid: 't1', product: 'shef.toolsai-mcp', type: 'annual', fp, expires_at: now + 365 * 86400, valid_until: now + 14 * 86400, max_major: 1 })).toString('base64url')}`
    const cert = `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`
    const post = (form: Record<string, string>) => fetch(`${BASE}/admin/license`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, ...form }) })
    const bad = await post({ action: 'install', cert: cert.replace(/.$/, c => c === 'A' ? 'B' : 'A') })
    expect(bad.status).toBe(400)
    const ok = await post({ action: 'install', cert })
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Лицензия действует: годовая')
    expect(logs).toMatch(/"action":"license.install","ok":true/)
    const works = await mcp(t.access_token, 'tools/call', { name: 'user_current', arguments: {} })
    expect(works.body.result.isError).toBeFalsy()
    fake.state.user = 7
  })

  it('посадочная: что это, встройка в коробку, типовые задачи с настоящими инструментами, цена', async () => {
    const r = await fetch(`${BASE}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).not.toContain('script-src')
    const html = await r.text()
    for (const s of ['Как это встроено в коробку', 'Подключить ИИ', '1200 BYN', `${BASE}/connect`, `${BASE}/admin`]) expect(html).toContain(s)
    expect(html).not.toContain('<script')
    // каждый инструмент из «Типовых задач» есть на сервере
    fake.state.user = 1
    const t = await fullToken()
    const names = new Set((await mcp(t.access_token, 'tools/list')).body.result.tools.map((x: any) => x.name))
    const used = [...html.matchAll(/<code>([a-z_]+)<\/code>/g)].map(m => m[1])
    expect(used.length).toBeGreaterThan(15)
    for (const n of used) expect(names, n).toContain(n)
    fake.state.user = 7
  })

  it('/connect: адрес сервера и шаги клиентов, встраивается в слайдер, без скриптов', async () => {
    const r = await fetch(`${BASE}/connect`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-security-policy')).toContain('frame-ancestors *')
    expect(r.headers.get('content-security-policy')).not.toContain('script-src')
    const html = await r.text()
    expect(html).toContain(`${BASE}/mcp`)
    for (const s of ['claude mcp add --transport http bitrix24', 'codex mcp add bitrix24 --url', 'mcpServers', '«Расширения»', 'auth: oauth', 'bitrix-best-practice']) expect(html).toContain(s)
    expect(html).not.toContain('<script')
  })
})
