import { toolGroup } from '../lib/access'
import type { Session } from '../lib/oauth'

// Группы инструментов, выключенные администратором портала на /admin, убираются из набора до
// регистрации: клиент их не видит и вызвать не может. Встроенная запись и инструменты модулей
// проверяют группы в своих плагинах.
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('mcp:config:resolved', async ({ config, event }) => {
    const session = event.context.session as Session | undefined
    if (!session) return
    const off = await useServices().access.groupsOff(session)
    if (!off.size) return
    const keep = config.tools.filter((t: { name?: string }) => {
      const g = toolGroup(String(t.name ?? ''))
      return !g || !off.has(g)
    })
    config.tools.splice(0, config.tools.length, ...keep)
  })
})
