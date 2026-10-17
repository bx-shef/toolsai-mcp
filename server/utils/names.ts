import { stageEntityId } from './crm'

// Имена вместо голых ID в списках: модель иначе либо отвечает «ответственный 7», либо делает
// лишние вызовы. Сбор имён — лучшие усилия: отказ портала не ломает сам список, просто без словаря.

type Item = Record<string, unknown>

/** Сотрудники по ID: один user.get с фильтром-массивом (проверено на живом портале). */
export async function userNames(tool: string, ids: unknown[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 50)
  if (!uniq.length) return {}
  try {
    const res = await b24Call(tool, 'user.get', { FILTER: { ID: uniq } })
    const out: Record<string, string> = {}
    for (const u of (res.result ?? []) as Item[]) out[String(u.ID)] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || `#${u.ID}`
    return out
  }
  catch {
    return {}
  }
}

/** Стадии записей CRM: crm.status.list по каждой встретившейся воронке (обычно одна). */
export async function stageNames(tool: string, etid: number, items: Item[]): Promise<Record<string, string>> {
  const ents = new Set<string>()
  for (const it of items) {
    if (it.stageId == null) continue
    const e = stageEntityId(etid, Number(it.categoryId ?? 0))
    if (e) ents.add(e)
  }
  const out: Record<string, string> = {}
  for (const e of [...ents].slice(0, 5)) {
    try {
      const res = await b24Call(tool, 'crm.status.list', { filter: { ENTITY_ID: e }, select: ['STATUS_ID', 'NAME'] })
      for (const s of (res.result ?? []) as Item[]) out[String(s.STATUS_ID)] = String(s.NAME)
    }
    catch { /* без словаря стадий */ }
  }
  return out
}
