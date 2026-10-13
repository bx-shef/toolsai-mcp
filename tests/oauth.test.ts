// Защитные проверки OAuth и клиента Битрикс24 — напрямую, без сервера: так проще подставить
// время, список сотрудников и ответы OAuth-сервера.
import { createHash, randomBytes } from 'node:crypto'
import { createStorage } from 'unstorage'
import { describe, expect, it } from 'vitest'
import { B24, fetchTransport, type B24Tokens } from '../server/lib/b24'
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
function fakeFetch(user = 7, expiresIn = 3600) {
  const calls: URL[] = []
  let n = 0
  const f = (async (input: any, init?: any) => {
    const u = new URL(String(input))
    calls.push(u)
    const json = (o: object, status = 200) => new Response(JSON.stringify(o), { status })
    if (u.pathname === '/oauth/token/') return json({ access_token: `at${++n}`, refresh_token: `rt${n}`, expires_in: expiresIn })
    if (u.pathname === '/rest/user.current.json') return json({ result: { ID: String(user) } })
    if (u.pathname === '/rest/crm.deal.get.json') return json({ result: { auth: JSON.parse(init.body).auth } })
    return json({ error: 'NOT_FOUND' }, 404)
  }) as typeof fetch
  return { f, calls }
}

function setup(allowed = '*', user = 7) {
  const cfg = env(allowed)
  const store = new Store(createStorage())
  const ff = fakeFetch(user)
  const b24 = new B24(cfg, store, ff.f, Date.now, fetchTransport(cfg, ff.f))
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
  await o.consent(txn, txn, true)
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
    expect(await s.b24.hasTokens(7)).toBe(false)
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
    await s.oauth.consent(txn, txn, true)
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
    await s.b24.login('c')
    const t = await s.store.get<B24Tokens>('b24:tokens:7')
    expect(t!.refreshEnc).not.toContain('rt1')
  })

  it('обновляет access заранее — за минуту до истечения', async () => {
    let now = 1_000_000
    const cfg = env()
    const store = new Store(createStorage(), () => now)
    const ff = fakeFetch(7, 3600)
    const b24 = new B24(cfg, store, ff.f, () => now, fetchTransport(cfg, ff.f))
    await b24.login('c')
    expect((await b24.call(7, 'crm.deal.get')).result.auth).toBe('at1')
    now += (3600 - 30) * 1000
    expect((await b24.call(7, 'crm.deal.get')).result.auth).toBe('at2')
    expect(ff.calls.filter(u => u.searchParams.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })

  it('имя метода REST — только буквы, цифры, точка, подчёркивание', async () => {
    const s = setup()
    await s.b24.login('c')
    await expect(s.b24.call(7, '../oauth/token')).rejects.toMatchObject({ code: 'bad_method' })
  })
})
