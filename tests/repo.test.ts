// Гарды репозитория: то, что не должно проскочить ревью незамеченным.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const md = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f)
  if (['node_modules', '.nuxt', '.output', '.git'].includes(f)) return []
  return statSync(p).isDirectory() ? md(p) : p.endsWith('.md') ? [p] : []
})

describe('repo', () => {
  it('порт опубликован только на 127.0.0.1 (Docker обходит firewalld)', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8')
    const ports = [...compose.matchAll(/^\s+- "([^"]+:\d+)"$/gm)].map(m => m[1])
    expect(ports.length).toBeGreaterThan(0)
    for (const p of ports) expect(p).toMatch(/^127\.0\.0\.1:/)
    // у Redis портов нет вовсе
    expect(compose.split('\n  redis:')[1]).not.toMatch(/ports:/)
  })

  it('в .env.example нет секретов', () => {
    const env = readFileSync('.env.example', 'utf8')
    for (const k of ['B24_CLIENT_SECRET', 'ENCRYPTION_KEY', 'B24_CLIENT_ID', 'REDIS_PASSWORD']) expect(env).toMatch(new RegExp(`^${k}=$`, 'm'))
  })

  it('штамп «Last reviewed» под заголовком каждого .md', () => {
    for (const f of md('.')) {
      const head = readFileSync(f, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').slice(0, 6).join('\n')
      expect(head, f).toMatch(/^> Last reviewed: \d{4}-\d{2}-\d{2}$/m)
    }
  })

  it('все инструменты — только чтение (запись — шаг 5 плана, отдельным PR)', () => {
    const dir = 'server/mcp/tools'
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8'), f).toMatch(/annotations: READ_ONLY/)
  })
  it('BUILTIN_TOOLS совпадает с файлами инструментов — модуль не перекроет встроенный', async () => {
    const { BUILTIN_TOOLS } = await import('../server/lib/manifest')
    const names = readdirSync('server/mcp/tools').map(f => /name: '([a-z_]+)'/.exec(readFileSync(join('server/mcp/tools', f), 'utf8'))![1])
    expect([...BUILTIN_TOOLS].sort()).toEqual(names.sort())
  })
})
