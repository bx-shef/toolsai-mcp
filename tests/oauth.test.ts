// Защитные проверки OAuth и клиента Битрикс24 — напрямую, без сервера: так проще подставить
// время, список сотрудников и ответы OAuth-сервера.
import { createHash, randomBytes } from 'node:crypto'
import { createStorage } from 'unstorage'
import { describe, expect, it } from 'vitest'
import { B24, fetchTransport, restEndpoint, type B24Tokens, type Resolve } from '../server/lib/b24'
import { loadConfig } from '../server/lib/config'
import { OAuthServer } from '../server/lib/oauth'
import { Store } from '../server/lib/store'

const RU = 'http://localhost:6274/cb'
const env = (allowed = '*') => loadConfig({
  PUBLIC_URL: 'https://p.example/mcp-ai', B24_PORTAL_URL: 'https://p.example', B24_CLIENT_ID: 'local.x',
  B24_CLIENT_SECRET: 'sec', ENCRYPTION_KEY: randomBytes(32).toString('base64'), ALLOWED_USERS: allowed,
  B24_OAUTH_SERVERS: 'https://oauth.bitrix.info',
})

/** Подставной Битрикс24: обмен кода и user.current; сотрудник — user. */
function fakeFetch(user = 7, expiresIn = 3600, endpoint = 'https://p.example/rest/') {
  const calls: URL[] = []
  let n = 0
  const f = (async (input: any, init?: any) => {
    const u = new URL(String(input))
    calls.push(u)
    const json = (o: object, status = 200) => new Response(JSON.stringify(o), { status })
    if (u.pathname === '/oauth/token/') return json({ access_token: `at${++n}`, refresh_token: `rt${n}`, expires_in: expiresIn, client_endpoint: endpoint, member_id: 'm0123456789' })
    if (u.pathname === '/rest/user.current.json') return json({ result: { ID: String(user) } })
    if (u.pathname === '/rest/crm.deal.get.json') return json({ result: { auth: JSON.parse(init.body).auth } })
    return json({ error: 'NOT_FOUND' }, 404)
  }) as typeof fetch
  return { f, calls }
}

/** DNS без сети: всё публичное, кроме явно названного. */
const dns = (map: Record<string, string[]> = {}): Resolve => async h => map[h] ?? ['93.184.216.34']

function setup(allowed = '*', user = 7, endpoint?: string, resolve: Resolve = dns()) {
  const cfg = env(allowed)
  const store = new Store(createStorage())
  const ff = fakeFetch(user, 3600, endpoint)
  const b24 = new B24(cfg, store, ff.f, Date.now, fetchTransport(cfg, ff.f), resolve)
  return { cfg, store, b24, oauth: new OAuthServer(cfg, store, b24), calls: ff.calls }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function codeFor(o: OAuthServer) {
  const c = await o.register({ redirect_uris: [RU] }) as any
  const { verifier, challenge } = pkce()
  const { txn } = await o.authorize({ client_id: c.client_id, redirect_uri: RU, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's' })
  await o.consent(txn, txn, true, 'p.example')
  const back = new URL(await o.callback({ code: 'c', state: txn, server_domain: 'oauth.bitrix.info' }, txn))
  return { clientId: c.client_id as string, verifier, code: back.searchParams.get('code')!, txn, back }
}

describe('OAuthServer: защитные проверки', () => {
  it('код с чужим redirect_uri или client_id — invalid_grant', async () => {
    const { oauth } = setup()
    for (const patch of [{ redirect_uri: 'http://localhost:1/other' }, { client_id: 'чужой' }]) {
      const c = await codeFor(oauth)
      await expect(oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: RU, code_verifier: c.verifier, ...patch }))
        .rejects.toMatchObject({ error: 'invalid_grant' })
    }
  })

  it('refresh чужого client_id — invalid_grant', async () => {
    const { oauth } = setup()
    const c = await codeFor(oauth)
    const t = await oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: RU, code_verifier: c.verifier })
    await expect(oauth.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: 'чужой' })).rejects.toMatchObject({ error: 'invalid_grant' })
  })

  it('ALLOWED_USERS проверяется на каждом запросе и при refresh', async () => {
    const s = setup('*')
    const c = await codeFor(s.oauth)
    const t = await s.oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: RU, code_verifier: c.verifier })
    expect(await s.oauth.verify(`Bearer ${t.access_token}`)).toMatchObject({ userId: 7 })
    // тот же стор, сотрудника убрали из списка
    const closed = new OAuthServer(env('1'), s.store, s.b24)
    expect(await closed.verify(`Bearer ${t.access_token}`)).toBeNull()
    await expect(closed.token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.clientId })).rejects.toMatchObject({ error: 'invalid_grant' })
  })

  it('отказ по ALLOWED_USERS — токены Битрикс24 сотрудника не остаются', async () => {
    const s = setup('1', 7)
    const c = await codeFor(s.oauth)
    expect(c.back.searchParams.get('error')).toBe('access_denied')
    expect(await s.b24.hasTokens({ memberId: 'm0123456789', host: 'p.example', userId: 7 })).toBe(false)
  })

  it('портал — из ответа OAuth-сервера: сотрудник 7 другого портала не проходит по «p.example:7»', async () => {
    const s = setup('p.example:7', 7, 'https://other.bitrix24.by/rest/')
    const c = await codeFor(s.oauth)
    expect(c.back.searchParams.get('error')).toBe('access_denied')
    const ok = await codeFor(setup('p.example:7', 7).oauth)
    expect(ok.back.searchParams.get('code')).toBeTruthy()
  })

  it('адрес портала на экране согласия: мусор — отказ, ввод в любом виде → вход на этот портал', async () => {
    const { oauth } = setup()
    const c = await oauth.register({ redirect_uris: [RU] }) as any
    const start = async () => (await oauth.authorize({ client_id: c.client_id, redirect_uri: RU, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256' })).txn
    for (const bad of ['', 'localhost', 'a b.by', 'https://u:p@x.bitrix24.by', 'x.bitrix24.by:8080', 'javascript:alert(1)']) {
      const txn = await start()
      await expect(oauth.consent(txn, txn, true, bad)).rejects.toMatchObject({ error: 'invalid_request' })
    }
    const txn = await start()
    const u = new URL(await oauth.consent(txn, txn, true, ' https://MyCo.Bitrix24.by/crm/deal/ '))
    expect(u.origin + u.pathname).toBe('https://myco.bitrix24.by/oauth/authorize/')
    expect(u.searchParams.get('state')).toBe(txn)
  })

  it('client_endpoint не https, IP, localhost или ведёт во внутреннюю сеть — вход не состоялся', async () => {
    expect(restEndpoint('https://10.0.0.5/rest/')).toBeNull()
    expect(restEndpoint('https://[::1]/rest/')).toBeNull()
    expect(restEndpoint('http://127.0.0.1:6379/')).toBeNull()
    expect(restEndpoint('http://127.0.0.1:6379/', true)).toBe('http://127.0.0.1:6379/')
    const inner = setup('*', 7, 'https://inner.evil.example/rest/', dns({ 'inner.evil.example': ['10.1.2.3'] }))
    const c0 = await codeFor(inner.oauth)
    expect(c0.back.searchParams.get('error')).toBe('server_error')
    expect(inner.calls.some(u => u.host === 'inner.evil.example')).toBe(false)
    for (const endpoint of ['http://evil.example/rest/', 'notaurl', 'https://169.254.169.254/rest/']) {
      const s = setup('*', 7, endpoint)
      const c = await codeFor(s.oauth)
      expect(c.back.searchParams.get('error')).toBe('server_error')
      expect(s.calls.some(u => u.host === 'evil.example')).toBe(false)
    }
  })

  it('возврат с портала одноразовый', async () => {
    const { oauth } = setup()
    const c = await codeFor(oauth)
    await expect(oauth.callback({ code: 'c', state: c.txn }, c.txn)).rejects.toMatchObject({ error: 'invalid_request' })
  })

  it('server_domain не из списка — на чужой хост ничего не уходит, клиенту server_error', async () => {
    const s = setup()
    const reg = await s.oauth.register({ redirect_uris: [RU] }) as any
    const { challenge } = pkce()
    const { txn } = await s.oauth.authorize({ client_id: reg.client_id, redirect_uri: RU, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' })
    await s.oauth.consent(txn, txn, true, 'p.example')
    const back = new URL(await s.oauth.callback({ code: 'c', state: txn, server_domain: 'evil.example' }, txn))
    expect(back.searchParams.get('error')).toBe('server_error')
    expect(s.calls.some(u => u.host === 'evil.example')).toBe(false)
  })

  it('регистрация: http не на localhost и фрагмент — отказ', async () => {
    const { oauth } = setup()
    for (const uri of ['http://evil.example/cb', 'https://a.example/cb#x', 'javascript:alert(1)']) {
      await expect(oauth.register({ redirect_uris: [uri] })).rejects.toMatchObject({ error: 'invalid_redirect_uri' })
    }
  })

  it('authorize: PKCE только S256 и ровно 43 символа', async () => {
    const { oauth } = setup()
    const c = await oauth.register({ redirect_uris: [RU] }) as any
    const base = { client_id: c.client_id, redirect_uri: RU, response_type: 'code', code_challenge_method: 'S256' }
    for (const bad of [{ code_challenge: 'a'.repeat(42) }, { code_challenge: 'a'.repeat(44) }, { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }]) {
      await expect(oauth.authorize({ ...base, ...bad })).rejects.toMatchObject({ error: 'invalid_request' })
    }
  })

  it('после входа адрес портала сменился на внутренний — REST не уходит', async () => {
    const map: Record<string, string[]> = {}
    const s = setup('*', 7, undefined, dns(map))
    const w = await s.b24.login('c')
    map['p.example'] = ['192.168.1.10']
    await expect(s.b24.call(w, 'crm.deal.get')).rejects.toMatchObject({ code: 'portal_private' })
    expect(s.calls.filter(u => u.pathname === '/rest/crm.deal.get.json')).toHaveLength(0)
  })

  it('сессия старой формы (без портала) не проходит даже при *', async () => {
    const s = setup('*')
    const c = await codeFor(s.oauth)
    const t = await s.oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: RU, code_verifier: c.verifier })
    const { sha256 } = await import('../server/lib/crypto')
    await s.store.put(`at:${sha256(t.access_token)}`, { userId: 7, clientId: c.clientId }, 600)
    expect(await s.oauth.verify(`Bearer ${t.access_token}`)).toBeNull()
  })

  it('отказ на экране согласия — без адреса портала, клиенту access_denied', async () => {
    const { oauth } = setup()
    const reg = await oauth.register({ redirect_uris: [RU] }) as any
    const { txn } = await oauth.authorize({ client_id: reg.client_id, redirect_uri: RU, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256' })
    expect(new URL(await oauth.consent(txn, txn, false, '')).searchParams.get('error')).toBe('access_denied')
  })

  it('ALLOWED_USERS по member_id: тот же хост, другой портал — отказ', async () => {
    const ok = await codeFor(setup('member:m0123456789:7').oauth)
    expect(ok.back.searchParams.get('code')).toBeTruthy()
    const other = await codeFor(setup('member:aaaaaaaaaa').oauth)
    expect(other.back.searchParams.get('error')).toBe('access_denied')
  })

  it('Bearer без учёта регистра, мусор — null', async () => {
    const { oauth } = setup()
    const c = await codeFor(oauth)
    const t = await oauth.token({ grant_type: 'authorization_code', code: c.code, client_id: c.clientId, redirect_uri: RU, code_verifier: c.verifier })
    expect(await oauth.verify(`bearer ${t.access_token}`)).not.toBeNull()
    expect(await oauth.verify(t.access_token)).toBeNull()
    expect(await oauth.verify('Bearer нет-такого')).toBeNull()
  })
})

describe('B24', () => {
  it('refresh хранится зашифрованным', async () => {
    const s = setup()
    const w = await s.b24.login('c')
    expect(w).toMatchObject({ memberId: 'm0123456789', host: 'p.example', userId: 7 })
    const t = await s.store.get<B24Tokens>('b24:tokens:m0123456789:7')
    expect(t!.refreshEnc).not.toContain('rt1')
  })

  it('обновляет access заранее — за минуту до истечения', async () => {
    let now = 1_000_000
    const cfg = env()
    const store = new Store(createStorage(), () => now)
    const ff = fakeFetch(7, 3600)
    const b24 = new B24(cfg, store, ff.f, () => now, fetchTransport(cfg, ff.f), dns())
    const w = await b24.login('c')
    expect((await b24.call(w, 'crm.deal.get')).result.auth).toBe('at1')
    now += (3600 - 30) * 1000
    expect((await b24.call(w, 'crm.deal.get')).result.auth).toBe('at2')
    expect(ff.calls.filter(u => u.searchParams.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })

  it('имя метода REST — только буквы, цифры, точка, подчёркивание', async () => {
    const s = setup()
    const w = await s.b24.login('c')
    await expect(s.b24.call(w, '../oauth/token')).rejects.toMatchObject({ code: 'bad_method' })
  })
})
