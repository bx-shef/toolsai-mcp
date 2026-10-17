// Посадочная страница MCP-сервера: что это, как встроено в коробку Битрикс24, какие типовые задачи
// решает, сколько стоит. Чистая сборка HTML без скриптов — тестируется напрямую (tests/lib.test.ts).
// Типовые задачи — по решениям Вайбкода (vibecode.bitrix24.tech/solutions, план #20), инструменты —
// те, что есть в сервере на самом деле (гард в тесте).

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))

export interface UseCase { title: string, ask: string, tools: string[] }

/** Типовые задачи: как их просят у ИИ и какими инструментами он это делает. */
export const USE_CASES: UseCase[] = [
  { title: 'Разбор сделки и следующий шаг', ask: '«Что с сделкой 42? Что сделать дальше?»', tools: ['crm_item_get', 'crm_activity_list', 'crm_stages'] },
  { title: 'Клиент по телефону и дубли', ask: '«Кто звонил с +375 29 111-22-33? Нет ли дублей?»', tools: ['crm_find', 'crm_item_get'] },
  { title: 'Изменить сделку с отчётом «было → стало»', ask: '«Переведи сделку в “Подготовку документов”, сумма 2500»', tools: ['crm_item_update'] },
  { title: 'Проект — в задачи и подзадачи', ask: '«Разбей запуск сайта на задачи с подзадачами и сроками»', tools: ['task_create', 'task_checklist_add'] },
  { title: 'Отчёт по задачам и времени', ask: '«Что Иван закрыл за неделю и сколько времени ушло?»', tools: ['task_list', 'task_elapsed', 'task_results'] },
  { title: 'Встреча с учётом занятости', ask: '«Найди окно на час с Анной и Петром в четверг и поставь встречу»', tools: ['calendar_busy', 'calendar_event_add'] },
  { title: 'Ответ по базе знаний', ask: '«Как у нас оформляют возврат? Ответь со ссылкой на статью»', tools: ['note_search', 'note_get'] },
  { title: 'Документ по шаблону', ask: '«Сделай акт по сделке 42»', tools: ['crm_doc_templates', 'crm_doc_create'] },
  { title: 'Описания товаров', ask: '«Допиши описания товарам без описания»', tools: ['catalog_products', 'catalog_product_update'] },
  { title: 'Статистика звонков', ask: '«Сколько пропущенных входящих за вчера и у кого?»', tools: ['calls_stats'] },
  { title: 'Сообщение сотруднику или в чат', ask: '«Напиши в чат отдела продаж итоги дня»', tools: ['im_chats', 'im_message_send'] },
  { title: 'Рабочий день и файлы', ask: '«Начни мой день» · «Разложи файлы по папкам клиентов»', tools: ['worktime_action', 'disk_folder', 'disk_move'] },
]

export function landingPage(publicUrl: string): string {
  const base = esc(publicUrl)
  const cases = USE_CASES.map(c => `<div class="card"><h3>${esc(c.title)}</h3><p class="ask">${esc(c.ask)}</p><p class="tools">${c.tools.map(t => `<code>${esc(t)}</code>`).join(' ')}</p></div>`).join('\n')
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ИИ-агенты в Битрикс24 — MCP-сервер</title>
<meta name="description" content="MCP-сервер для Битрикс24 (облако и коробка): Claude, Коворк, Codex, Cursor и агенты Вайбкода работают с CRM, задачами, календарём и базой знаний от имени сотрудника, в рамках его прав.">
<style>
:root{--blue:#2fc6f6;--ink:#1f2a37;--mut:#5b6675;--bg:#f5f7fa;--card:#fff;--line:#e3e8ef}
@media (prefers-color-scheme:dark){:root{--ink:#e8edf3;--mut:#a3adba;--bg:#11161d;--card:#1a212b;--line:#2b3440}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--bg)}
.w{max-width:66rem;margin:0 auto;padding:0 1rem}header{padding:3.5rem 0 2.5rem;background:linear-gradient(135deg,#0b3d91,#2fc6f6);color:#fff}
h1{font-size:2.2rem;line-height:1.2;margin:0 0 1rem}header p{font-size:1.15rem;max-width:44rem;margin:0 0 1.5rem;opacity:.95}
.b{display:inline-block;padding:.75rem 1.3rem;margin:.3rem .6rem .3rem 0;border-radius:.5rem;font-weight:600;text-decoration:none}
.b1{background:#fff;color:#0b3d91}.b2{border:1px solid #fff;color:#fff}
h2{font-size:1.5rem;margin:2.8rem 0 1rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(19rem,1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.7rem;padding:1rem 1.1rem}.card h3{margin:0 0 .4rem;font-size:1.05rem}
.ask{color:var(--mut);margin:.2rem 0 .6rem}.tools code{font:12px ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:.3rem;padding:0 .3rem;white-space:nowrap}
.flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:.6rem}.flow .card{flex:1 1 12rem}.arr{align-self:center;font-size:1.4rem;color:var(--blue)}
.price{font-size:2rem;font-weight:700}small,.mut{color:var(--mut)}footer{margin:3rem 0 2rem;color:var(--mut);font-size:.9rem}
ul.ok{padding-left:1.2rem}ul.ok li{margin:.3rem 0}
</style></head><body>
<header><div class="w">
<h1>ИИ-агенты работают в вашем Битрикс24</h1>
<p>MCP-сервер подключает Claude, Битрикс24 Коворк, Codex, Cursor и агентов Вайбкода к CRM, задачам, календарю,
базе знаний, диску и каталогу. Облако и коробка. Каждый запрос — от имени сотрудника и только в рамках его прав.</p>
<a class="b b1" href="${base}/connect">Подключить ИИ</a><a class="b b2" href="${base}/admin">Настройки и тестовая лицензия</a>
</div></header>
<main class="w">

<h2>Как это встроено в коробку</h2>
<div class="flow">
<div class="card"><h3>1. Сотрудник</h3><p class="mut">Пишет задачу своими словами в Claude, Коворке, Codex, Cursor или в агенте Вайбкода.</p></div>
<div class="arr">→</div>
<div class="card"><h3>2. Вход через Битрикс24</h3><p class="mut">Клиент один раз входит через приложение портала (OAuth). Пароль ИИ не видит.</p></div>
<div class="arr">→</div>
<div class="card"><h3>3. MCP-сервер</h3><p class="mut">Узкие инструменты: сделка, задача, встреча, статья. Проверяет права портала и лицензию, ведёт журнал.</p></div>
<div class="arr">→</div>
<div class="card"><h3>4. Ваш портал</h3><p class="mut">REST от имени сотрудника: видно ровно то, что видит он сам. Сервер стоит рядом с порталом на BitrixVM или у нас.</p></div>
</div>
<div class="grid" style="margin-top:1rem">
<div class="card"><h3>Кнопка «Подключить ИИ» в CRM</h3><p class="mut">Модуль shef.toolsai: в «Виде «ИИ»» кнопка открывает адрес сервера и шаги для каждого клиента прямо в слайдере портала.</p></div>
<div class="card"><h3>Чат ИИ-помощника справа</h3><p class="mut">Модуль shef.toolsaiassistant: чат с ролями в CRM, типовые запросы под рукой — для тех, кому не нужен внешний клиент.</p></div>
<div class="card"><h3>Администратор решает, что можно</h3><p class="mut">Страница настроек: выключатель MCP для всех, группы инструментов, кто пользуется и кто меняет данные — коды доступа Битрикс24 (отделы, группы, сотрудники).</p></div>
</div>

<h2>Типовые задачи</h2>
<div class="grid">
${cases}
</div>

<h2>Безопасность</h2>
<ul class="ok">
<li>Кто вызывает — только из токена: ИИ не может назвать себя другим сотрудником или порталом.</li>
<li>Права Битрикс24 действуют всегда: чужие сделки и задачи ИИ не увидит.</li>
<li>Запись — отдельным списком сотрудников, с ответом «было → стало».</li>
<li>В журнале — только имена аргументов, без значений; ответы портала не сохраняются.</li>
<li>Токены портала — в Redis, refresh зашифрован. Порт сервера — только 127.0.0.1 за nginx портала.</li>
</ul>

<h2>Стоимость</h2>
<div class="grid">
<div class="card"><h3>Тестовая</h3><p class="price">0 BYN</p><p class="mut">15 дней, все инструменты. Оформляется на странице настроек: организация, УНП, e-mail.</p></div>
<div class="card"><h3>Годовая</h3><p class="price">1200 BYN</p><p class="mut">За портал в год, любое число сотрудников. Ключ — после оплаты счёта, продление — счётом на следующий год.</p></div>
<div class="card"><h3>Внедрение</h3><p class="price">по задаче</p><p class="mut">Установка рядом с порталом на BitrixVM, свои инструменты для модулей портала, обучение сотрудников.</p></div>
</div>

</main>
<footer class="w">ИП Шевчик · bx-shef · Адрес сервера для клиентов: <code>${base}/mcp</code></footer>
</body></html>`
}
