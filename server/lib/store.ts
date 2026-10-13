import type { Storage } from 'unstorage'
import { withLock } from './lock'

// Ключ-значение со сроком поверх unstorage (Redis на сервере, память в тестах).
// Срок проверяется при чтении — не зависим от того, умеет ли драйвер TTL.

interface Boxed<T> { v: T, exp: number }

export class Store {
  constructor(private readonly s: Storage, private readonly now = () => Date.now()) {}

  async put<T>(key: string, value: T, ttlSec: number): Promise<void> {
    await this.s.setItem(key, { v: value, exp: this.now() + ttlSec * 1000 }, { ttl: ttlSec })
  }

  async get<T>(key: string): Promise<T | null> {
    const b = await this.s.getItem<Boxed<T>>(key)
    if (!b) return null
    if (b.exp <= this.now()) {
      await this.s.removeItem(key)
      return null
    }
    return b.v
  }

  /** Прочитать и удалить — для одноразового (коды авторизации, входы); под блокировкой, чтобы два запроса не взяли одно. */
  take<T>(key: string): Promise<T | null> {
    return withLock(`take:${key}`, async () => {
      const v = await this.get<T>(key)
      if (v !== null) await this.s.removeItem(key)
      return v
    })
  }

  del(key: string) {
    return this.s.removeItem(key)
  }
}
