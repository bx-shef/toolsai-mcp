// Журнал действий: кто, какой инструмент, какой метод REST, итог, время.
// ЗНАЧЕНИЯ аргументов не пишем — там бывают персональные данные (имена, телефоны), только имена.
// Строка JSON в stdout, хранит docker (docker-compose.yml, logging); смотреть — make audit.

export interface AuditEntry {
  /** Хост портала: сервер работает с любым Битрикс24, ID сотрудника без портала неоднозначен. */
  portal: string
  user: number
  tool: string
  method?: string
  args: string[]
  ok: boolean
  error?: string
  ms: number
}

export function audit(e: AuditEntry, write: (line: string) => void = l => process.stdout.write(`${l}\n`)) {
  write(JSON.stringify({ t: new Date().toISOString(), kind: 'audit', ...e }))
}
