// Страница «Как подключить»: адрес сервера и шаги для клиентов. Чистая сборка HTML — тестируется напрямую.
// Источники шагов (сверено 2026-10-17):
//  Коворк/Код — helpdesk.bitrix24.ru/open/29122946 («Настройки → Расширения → (+) MCP»);
//  Hermes (AI-агенты Вайбкода) — hermes-agent.nousresearch.com/docs/user-guide/features/mcp;
//  плагин bitrix-tools/best-practice — github.com/bitrix-tools/best-practice, «Установка плагина»;
//  Codex, Cursor — .bitrix-docs/b24-rest-docs/ai-tools/mcp.md (тот же формат удалённого сервера).

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))

export function connectPage(publicUrl: string): string {
  const url = `${publicUrl}/mcp`
  const u = esc(url)
  const code = (s: string) => `<pre><code>${esc(s)}</code></pre>`
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Подключить ИИ к Битрикс24</title><style>body{font:15px system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#222;line-height:1.45}
pre{background:#f4f5f7;padding:.6rem .8rem;border-radius:.4rem;overflow-x:auto}code{font:13px ui-monospace,monospace}h2{margin-top:1.8rem;font-size:1.15rem}
.u{font-size:1.05rem;background:#eaf7fd;padding:.6rem .8rem;border-radius:.4rem;word-break:break-all}small{color:#666}</style></head><body>
<h1>Подключить ИИ к Битрикс24</h1>
<p>Адрес MCP-сервера:</p><p class="u"><code>${u}</code></p>
<p>Вход — через ваш Битрикс24: ИИ работает от вашего имени и видит только то, что видите вы. Что именно ему можно —
решает администратор портала. Транспорт — <b>HTTP (Streamable HTTP)</b>, авторизация — <b>OAuth</b> (клиент откроет страницу входа сам).</p>

<h2>Claude (claude.ai и приложение)</h2>
<p>Настройки → Коннекторы → «Добавить свой коннектор» → вставить адрес → «Подключить», войти в Битрикс24.</p>

<h2>Claude Code</h2>
${code(`claude mcp add --transport http bitrix24 ${url}`)}
<p>Затем в сессии <code>/mcp</code> → bitrix24 → войти. Для разработки под Битрикс добавьте плагин практик:</p>
${code('claude plugin marketplace add https://github.com/bitrix-tools/best-practice\nclaude plugin install bitrix-best-practice@bitrix-best-practice --scope project')}

<h2>Codex</h2>
${code(`codex mcp add bitrix24 --url ${url}\ncodex mcp login bitrix24`)}
<p>Плагин практик:</p>
${code('codex plugin marketplace add https://github.com/bitrix-tools/best-practice\ncodex plugin add bitrix-best-practice@bitrix-best-practice')}

<h2>Cursor</h2>
<p>Cursor Settings → Tools &amp; MCP → New MCP server, в <code>~/.cursor/mcp.json</code> (или <code>.cursor/mcp.json</code> проекта):</p>
${code(JSON.stringify({ mcpServers: { bitrix24: { url } } }, null, 2))}
<p>Плагин практик: Customize → Plugins → From GitHub Repository → <code>https://github.com/bitrix-tools/best-practice</code>.</p>

<h2>Битрикс24 Коворк/Код</h2>
<ol><li>Аватар внизу слева → «Настройки» → «Расширения» → «(+) MCP».</li>
<li>Тип — «Удалённый (URL)», название — «Битрикс24», адрес — выше.</li>
<li>Включить «Сервер с OAuth-авторизацией» → «Подключить», войти в Битрикс24 и подтвердить доступ.</li></ol>
<p><small>Можно и из сеанса: значок гаечного ключа под полем ввода → вкладка «MCP» → «Добавить MCP».</small></p>

<h2>AI-агенты Вайбкода (Hermes)</h2>
<p>В <code>~/.hermes/config.yaml</code> агента:</p>
${code(`mcp_servers:\n  bitrix24:\n    url: "${url}"\n    auth: oauth`)}
<p>Затем <code>hermes mcp login bitrix24</code> (ссылка на вход появится в терминале) и <code>/reload-mcp</code> в сессии.
<small>Агент на сервере Вайбкода ждёт ответ входа на своём локальном порту — если вход не завершается, подключите агента там,
где открывается браузер, или попросите администратора.</small></p>

<h2>Не получается</h2>
<p><small>«Доступ к MCP для этого сотрудника не открыт» — попросите администратора портала открыть доступ на странице
<code>${esc(publicUrl)}/admin</code>. Инструментов меньше, чем ожидали, — часть групп или запись выключены там же.</small></p>
</body></html>`
}
