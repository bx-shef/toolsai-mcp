import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import redisDriver from 'unstorage/drivers/redis'
import { Access } from '../lib/access'
import { AdminAuth } from '../lib/admin'
import { B24 } from '../lib/b24'
import { Licensing, PUBLIC_KEYS } from '../lib/license'
import { loadConfig, type Config } from '../lib/config'
import { OAuthServer } from '../lib/oauth'
import { Store } from '../lib/store'

// Один набор служб на процесс. REDIS_URL пуст — память (только локально:
// входы теряются при перезапуске).

let services: { cfg: Config, store: Store, b24: B24, access: Access, admin: AdminAuth, oauth: OAuthServer, license: Licensing } | undefined

export function useServices() {
  if (!services) {
    const cfg = loadConfig()
    const driver = process.env.REDIS_URL
      ? redisDriver({ url: process.env.REDIS_URL, base: 'mcp' })
      : memoryDriver()
    const store = new Store(createStorage({ driver }))
    const b24 = new B24(cfg, store)
    const access = new Access(cfg, store, b24)
    // Лицензия: LICENSE_REQUIRED=1 включает гейт; LICENSE_PUBLIC_KEYS (kid:base64,…) и LICENSE_SERVER — для стенда и тестов
    const keys = process.env.LICENSE_PUBLIC_KEYS?.trim()
      ? Object.fromEntries(process.env.LICENSE_PUBLIC_KEYS.split(',').map(p => p.trim().split(':') as [string, string]))
      : PUBLIC_KEYS
    const license = new Licensing(store, { keys, server: process.env.LICENSE_SERVER?.trim() || undefined, required: process.env.LICENSE_REQUIRED === '1' })
    services = { cfg, store, b24, access, admin: new AdminAuth(store, b24, access), oauth: new OAuthServer(cfg, store, b24, access), license }
  }
  return services
}
