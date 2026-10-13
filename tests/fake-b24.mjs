// Подставной Битрикс24: портал (/rest/*) и OAuth-сервер (/oauth/token/) на одном порту.
// Для tests/e2e.test.ts. Повторяет только проверенное по документации поведение.
import { createServer } from 'node:http'

export function startFakeB24() {
  const calls = []
  let n = 0
  const tokens = new Map() // access -> userId
  const refresh = new Map() // refresh -> userId
  const state = { user: 7, expireNext: false }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    for await (const c of req) body += c
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null })
    if (url.pathname === '/oauth/token/') {
      const q = url.searchParams
      if (q.get('client_secret') !== 'sec') return json(401, { error: 'invalid_client' })
      let uid
      if (q.get('grant_type') === 'authorization_code') {
        if (!q.get('code')?.startsWith('b24code-')) return json(400, { error: 'invalid_grant' })
        uid = state.user
      } else {
        uid = refresh.get(q.get('refresh_token'))
        refresh.delete(q.get('refresh_token'))
        if (!uid) return json(400, { error: 'invalid_grant' })
      }
      const at = `at${++n}`, rt = `rt${n}`
      tokens.set(at, uid); refresh.set(rt, uid)
      return json(200, { access_token: at, refresh_token: rt, expires_in: 3600 })
    }
    if (url.pathname.startsWith('/rest/')) {
      const p = JSON.parse(body || '{}')
      const uid = tokens.get(p.auth)
      if (!uid) return json(401, { error: 'invalid_token' })
      if (state.expireNext) { state.expireNext = false; tokens.delete(p.auth); return json(401, { error: 'expired_token' }) }
      const method = url.pathname.slice(6).replace(/\.json$/, '')
      if (method === 'user.current') return json(200, { result: { ID: String(uid), NAME: 'Тест', LAST_NAME: 'Тестов' } })
      if (method === 'crm.deal.get') return json(200, { result: { ID: String(p.id), TITLE: `Сделка ${p.id}`, _asUser: uid } })
      return json(400, { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found' })
    }
    json(404, {})
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, state, url: `http://127.0.0.1:${server.address().port}` })))
}
