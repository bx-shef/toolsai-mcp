import { createStorage } from 'unstorage'
import memoryDriver from 'unstorage/drivers/memory'
import redisDriver from 'unstorage/drivers/redis'
import { B24 } from '../lib/b24'
import { loadConfig, type Config } from '../lib/config'
import { OAuthServer } from '../lib/oauth'
import { Store } from '../lib/store'

// Один набор служб на процесс. REDIS_URL пуст — память (только локально:
// входы теряются при перезапуске).

let services: { cfg: Config, store: Store, b24: B24, oauth: OAuthServer } | undefined

export function useServices() {
  if (!services) {
    const cfg = loadConfig()
    const driver = process.env.REDIS_URL
      ? redisDriver({ url: process.env.REDIS_URL, base: 'mcp' })
      : memoryDriver()
    const store = new Store(createStorage({ driver }))
    const b24 = new B24(cfg, store)
    services = { cfg, store, b24, oauth: new OAuthServer(cfg, store, b24) }
  }
  return services
}
