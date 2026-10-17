import { z } from 'zod'
import { toolGroup } from '../lib/access'
import type { Session } from '../lib/oauth'
import { WRITE_TOOLS } from '../lib/manifest'

// Встроенная запись: задачи, календарь, база знаний. Инструменты появляются только у тех, кому администратор портала
// открыл запись (/admin, «Кто может менять данные») — остальные их не видят вовсе. Действует сотрудник
// своими правами в Битрикс24. Изменение отвечает «было → стало», чтобы человек видел, что поменялось;
// журнал — только имена аргументов (как у чтения). Формы запросов сверены на тестовом портале 2026-10-16.

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const
const id = z.coerce.number().int().positive()
const dateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/, 'Дата ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTчч:мм[:сс][+03:00]')

const STATUS: Record<string, string> = { 1: 'новая', 2: 'ждёт выполнения', 3: 'выполняется', 4: 'ждёт контроля', 5: 'завершена', 6: 'отложена', 7: 'отклонена' }
const statusName = (s: unknown) => STATUS[String(s)] ?? String(s)

/** Поля задачи для «было/стало»: имя в tasks.task.update → имя в ответе tasks.task.get. */
const FIELDS = { TITLE: 'title', DESCRIPTION: 'description', DEADLINE: 'deadline', RESPONSIBLE_ID: 'responsibleId' } as const

async function taskFields(taskId: number) {
  const { result } = await b24Call('task_update', 'tasks.task.get', { taskId, select: ['ID', ...Object.keys(FIELDS), 'STATUS'] }, { taskId })
  if (!result?.task) throw createError({ statusCode: 404, message: 'Не найдено: задачи с таким ID нет или она недоступна сотруднику' })
  return result.task as Record<string, unknown>
}

type Handler = (args: any) => Promise<unknown>
interface Def { title: string, description: string, input: Record<string, z.ZodType>, handler: Handler }

const defs: Record<(typeof WRITE_TOOLS)[number], Def> = {
  task_create: {
    title: 'Создать задачу',
    description: 'Создать задачу. Ответственный по умолчанию — сам сотрудник. crm — привязки вида D_12 (сделка), L_3 (лид), C_5 (контакт), CO_7 (компания).',
    input: {
      title: z.string().min(1).max(250),
      description: z.string().max(20000).optional(),
      responsibleId: id.optional(),
      deadline: dateTime.optional(),
      groupId: id.optional(),
      crm: z.array(z.string().regex(/^(D|L|C|CO)_\d+$/)).max(20).optional(),
    },
    handler: async (a) => {
      const fields: Record<string, unknown> = { TITLE: a.title }
      if (a.description !== undefined) fields.DESCRIPTION = a.description
      fields.RESPONSIBLE_ID = a.responsibleId ?? (await b24Call('task_create', 'user.current', {}, {})).result.ID
      if (a.deadline) fields.DEADLINE = a.deadline
      if (a.groupId) fields.GROUP_ID = a.groupId
      if (a.crm?.length) fields.UF_CRM_TASK = a.crm
      const { result } = await b24Call('task_create', 'tasks.task.add', { fields }, a)
      const t = result?.task ?? {}
      return { id: Number(t.id), title: t.title, status: statusName(t.status), deadline: t.deadline ?? null, responsibleId: Number(t.responsibleId) }
    },
  },
  task_update: {
    title: 'Изменить задачу',
    description: 'Изменить название, описание, крайний срок или ответственного. Ответ — что было и что стало.',
    input: {
      taskId: id,
      title: z.string().min(1).max(250).optional(),
      description: z.string().max(20000).optional(),
      deadline: dateTime.optional(),
      responsibleId: id.optional(),
    },
    handler: async (a) => {
      const fields: Record<string, unknown> = {}
      if (a.title !== undefined) fields.TITLE = a.title
      if (a.description !== undefined) fields.DESCRIPTION = a.description
      if (a.deadline !== undefined) fields.DEADLINE = a.deadline
      if (a.responsibleId !== undefined) fields.RESPONSIBLE_ID = a.responsibleId
      if (!Object.keys(fields).length) throw createError({ statusCode: 400, message: 'Нечего менять: укажите хотя бы одно поле' })
      const before = await taskFields(a.taskId)
      const { result } = await b24Call('task_update', 'tasks.task.update', { taskId: a.taskId, fields }, a)
      const after = result?.task ?? {}
      const changes: Record<string, { было: unknown, стало: unknown }> = {}
      for (const k of Object.keys(fields) as (keyof typeof FIELDS)[]) changes[FIELDS[k]] = { было: before[FIELDS[k]] ?? null, стало: after[FIELDS[k]] ?? null }
      return { taskId: a.taskId, changes }
    },
  },
  task_status: {
    title: 'Сменить статус задачи',
    description: 'Начать (start), приостановить (pause), завершить (complete), отложить (defer) или вернуть в работу (renew).',
    input: { taskId: id, action: z.enum(['start', 'pause', 'complete', 'defer', 'renew']) },
    handler: async (a) => {
      const before = await taskFields(a.taskId)
      const { result } = await b24Call('task_status', `tasks.task.${a.action}`, { taskId: a.taskId }, a)
      return { taskId: a.taskId, status: { было: statusName(before.status), стало: statusName(result?.task?.status) } }
    },
  },
  task_checklist_add: {
    title: 'Добавить пункт чек-листа',
    description: 'Добавить пункт в чек-лист задачи (если чек-листа нет — портал создаст его).',
    input: { taskId: id, title: z.string().min(1).max(500) },
    handler: async (a) => ({ itemId: (await b24Call('task_checklist_add', 'task.checklistitem.add', { TASKID: a.taskId, FIELDS: { TITLE: a.title } }, a)).result }),
  },
  task_checklist_done: {
    title: 'Отметить пункт чек-листа',
    description: 'Отметить пункт чек-листа выполненным (done: true) или снять отметку (done: false). ID пункта — из task_checklist.',
    input: { taskId: id, itemId: id, done: z.boolean().default(true) },
    handler: async (a) => {
      await b24Call('task_checklist_done', a.done ? 'task.checklistitem.complete' : 'task.checklistitem.renew', { TASKID: a.taskId, ITEMID: a.itemId }, a)
      return { taskId: a.taskId, itemId: a.itemId, done: a.done }
    },
  },
  task_comment_add: {
    title: 'Написать комментарий в задачу',
    description: 'Сообщение в чат задачи от имени сотрудника — обсуждение, вопрос, промежуточный отчёт. Итог работы — task_result_add.',
    input: { taskId: id, text: z.string().min(1).max(20000) },
    handler: async (a) => {
      // tasks.task.chat.message.send — замена task.commentitem.add (DEPRECATED с tasks 25.700.0), только REST v3:
      // .bitrix-docs/b24-rest-docs/api-reference/tasks/tasks-task-chat-message-send.md, проверено 2026-10-17.
      // Коробка старее — метода нет: старый способ (комментарий форума).
      try {
        await b24Call('task_comment_add', 'tasks.task.chat.message.send', { fields: { taskId: a.taskId, text: a.text } }, a)
        return { taskId: a.taskId, sent: true, via: 'chat' }
      }
      catch (e) {
        if (!/METHODNOTFOUND|ERROR_METHOD_NOT_FOUND/i.test(String((e as { message?: string }).message))) throw e
        const res = await b24Call('task_comment_add', 'task.commentitem.add', { TASKID: a.taskId, FIELDS: { POST_MESSAGE: a.text } }, a)
        return { taskId: a.taskId, sent: true, via: 'forum', commentId: res.result }
      }
    },
  },
  task_result_add: {
    title: 'Записать результат задачи',
    description: 'Итог работы по задаче — отметка «Результат» (видна в задаче отдельно от обсуждения). Текст — что сделано.',
    input: { taskId: id, text: z.string().min(1).max(20000) },
    handler: async (a) => {
      // REST v3: .bitrix-docs/b24-rest-docs/api-reference/tasks/result/tasks-task-result-add.md, проверено 2026-10-17
      const item = (await b24Call('task_result_add', 'tasks.task.result.add', { fields: { taskId: a.taskId, text: a.text } }, a)).result?.item ?? {}
      return { taskId: a.taskId, resultId: item.id, createdAt: item.createdAt }
    },
  },
  calendar_event_add: {
    title: 'Создать встречу в календаре',
    description: 'Событие в своём календаре; с участниками — встреча, им придёт приглашение. Свободное время — calendar_busy.',
    input: {
      name: z.string().min(1).max(250),
      from: dateTime,
      to: dateTime,
      timezone: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_]+$/).default('Europe/Minsk'),
      description: z.string().max(5000).optional(),
      attendees: z.array(id).max(50).optional(),
    },
    handler: async (a) => {
      const me = Number((await b24Call('calendar_event_add', 'user.current', {}, {})).result.ID)
      const params: Record<string, unknown> = {
        type: 'user', ownerId: me, name: a.name, from: a.from, to: a.to,
        timezone_from: a.timezone, timezone_to: a.timezone, description: a.description ?? '',
      }
      if (a.attendees?.length) Object.assign(params, { is_meeting: 'Y', host: me, attendees: [...new Set([me, ...a.attendees])] })
      return { eventId: (await b24Call('calendar_event_add', 'calendar.event.add', params, a)).result }
    },
  },
  note_add: {
    title: 'Создать статью в базе знаний',
    description: 'Новая статья в базе знаний (текст — Markdown). parentId — чтобы вложить в другую статью. ID базы — из note_bases.',
    input: { collectionId: id, title: z.string().min(1).max(255), markdown: z.string().max(500_000).default(''), parentId: id.optional() },
    handler: async (a) => {
      const fields: Record<string, unknown> = { collectionId: a.collectionId, title: a.title, markdown: a.markdown }
      if (a.parentId) fields.parentId = a.parentId
      const d = (await b24Call('note_add', 'note.document.add', { fields }, a)).result?.item ?? {}
      return { id: d.id, collectionId: d.collectionId, title: d.title }
    },
  },
  note_update: {
    title: 'Изменить статью базы знаний',
    description: 'Заменить заголовок и/или текст статьи (Markdown целиком, не дописывание). Ответ — что было и что стало (текст — длиной).',
    input: { id, title: z.string().min(1).max(255).optional(), markdown: z.string().max(500_000).optional() },
    handler: async (a) => {
      const fields: Record<string, unknown> = {}
      if (a.title !== undefined) fields.title = a.title
      if (a.markdown !== undefined) fields.markdown = a.markdown
      if (!Object.keys(fields).length) throw createError({ statusCode: 400, message: 'Нечего менять: укажите title или markdown' })
      const before = (await b24Call('note_update', 'note.document.get', { id: a.id }, { id: a.id })).result?.item ?? {}
      // overwrite не передаём: если статью сейчас правят в редакторе, портал откажет, а не затрёт чужое
      const after = (await b24Call('note_update', 'note.document.update', { id: a.id, fields }, a)).result?.item ?? {}
      const changes: Record<string, { было: unknown, стало: unknown }> = {}
      if ('title' in fields) changes.title = { было: before.title ?? null, стало: after.title ?? null }
      if ('markdown' in fields) changes.markdown = { было: `${String(before.markdown ?? '').length} символов`, стало: `${String(after.markdown ?? '').length} символов` }
      return { id: a.id, changes }
    },
  },
  task_time_add: {
    title: 'Записать затраченное время',
    description: 'Добавить запись учёта времени в задачу: минуты и комментарий (что сделано).',
    input: { taskId: id, minutes: z.coerce.number().int().min(1).max(24 * 60), comment: z.string().max(2000).optional() },
    handler: async (a) => {
      const res = await b24Call('task_time_add', 'task.elapseditem.add', { TASKID: a.taskId, ARFIELDS: { SECONDS: a.minutes * 60, COMMENT_TEXT: a.comment ?? '' } }, a)
      return { taskId: a.taskId, recordId: res.result, minutes: a.minutes }
    },
  },
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('mcp:server:created', async ({ server, event }) => {
    const session = event.context.session as Session | undefined
    if (!session || !await useServices().access.canWrite(session)) return
    const off = await useServices().access.groupsOff(session)
    for (const name of WRITE_TOOLS) {
      const g = toolGroup(name)
      if (g && off.has(g)) continue
      const d = defs[name]
      server.registerTool(name, { title: d.title, description: d.description, inputSchema: d.input as never, annotations: WRITE }, (async (args: Record<string, unknown>) => {
        try {
          return { content: [{ type: 'text' as const, text: JSON.stringify(await d.handler(args), null, 2) }] }
        }
        catch (e) {
          const err = e as { statusCode?: number, message?: string }
          return { content: [{ type: 'text' as const, text: `[${err.statusCode ?? 500}] ${err.message ?? 'Ошибка'}` }], isError: true }
        }
      }) as never)
    }
  })
})
