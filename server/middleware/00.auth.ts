import { authServerMetadata, MCP_PATH, protectedResourceMetadata } from '../lib/oauth'

// Метаданные OAuth и проверка Bearer. Middleware, а не маршруты: @nuxtjs/mcp-toolkit сам ставит на
// /.well-known/* заглушки 404 («OAuth is not configured»), а middleware отрабатывает раньше них.
//
// За nginx портала сервер живёт под префиксом (PUBLIC_URL = https://портал/mcp-ai). Клиенты ищут
// метаданные и со вставкой пути (RFC 8414/9728: /.well-known/x/mcp-ai[/mcp]), и в самом issuer
// (/mcp-ai/.well-known/x); nginx приводит обе формы к /.well-known/x… (deploy/bitrixvm/nginx-mcp.conf).
export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0] ?? ''
  if (path.startsWith('/.well-known/')) {
    const { cfg } = useServices()
    const name = path.slice('/.well-known/'.length).split('/')[0]
    setResponseHeader(event, 'Access-Control-Allow-Origin', '*')
    if (name === 'oauth-protected-resource') return protectedResourceMetadata(cfg)
    if (name === 'oauth-authorization-server' || name === 'openid-configuration') return authServerMetadata(cfg)
    return
  }

  if (path === MCP_PATH || path.startsWith(`${MCP_PATH}/`)) {
    const { cfg, oauth } = useServices()
    const session = await oauth.verify(getRequestHeader(event, 'authorization'))
    if (!session) {
      setResponseHeader(event, 'WWW-Authenticate',
        `Bearer resource_metadata="${cfg.publicUrl}/.well-known/oauth-protected-resource"`)
      setResponseStatus(event, 401)
      return { error: 'invalid_token', error_description: 'Нужен вход через Битрикс24' }
    }
    event.context.session = session
  }
})
