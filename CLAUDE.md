# CLAUDE.md

> Last reviewed: 2026-10-14

MCP-сервер (Nuxt + `@nuxtjs/mcp-toolkit`, Docker, Redis) для любого Битрикс24 (облако и коробка); выкат — на BitrixVM.
Пускает внешний ИИ к данным портала от имени сотрудника — через его OAuth-токен Битрикс24.
Задание — `bx-shef/toolsai`, `docs/private/mcp-box.md`.

**Правила процесса — [`docs/AGENT_RULES.md`](docs/AGENT_RULES.md): они главнее этого файла.**
Коротко: в `main` только через PR (каждый коммит `main` выкатывается на VM портала за ~5 минут);
собрал или доработал PR — `/code-review` и панель из пяти (навык `review-panel`); мерж — навык `merge-pr`.

## Команды

```bash
npm ci
npm run typecheck                 # типы сервера
npm run build && npm test         # сквозные тесты гоняют собранный .output против подставного Битрикс24
shellcheck deploy/bitrixvm/mcp-deploy.sh
cp .env.example .env              # заполнить; затем:
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Карта

| Где | Что |
|---|---|
| `server/lib/` | чистая логика без автоимпортов Nuxt (тестируется напрямую): `config`, `crypto` (PKCE, AES-GCM), `store` (KV с истечением), `lock`, `b24` (обмен кода, refresh под блокировкой, REST через b24jssdk), `oauth` (наш сервер авторизации), `audit` |
| `server/middleware/00.auth.ts` | `/.well-known/*` (метаданные) и проверка Bearer на `/mcp` → `event.context.session` |
| `server/routes/oauth/` | `register`, `authorize` (экран согласия + cookie входа, `server/utils/consent.ts`), `consent`, `callback` (возврат с портала), `token` |
| `server/mcp/tools/` | инструменты MCP; REST — только через `b24Call()` (`server/utils/b24call.ts`): сотрудник из сессии, журнал |
| `server/lib/access.ts`, `server/lib/admin.ts`, `server/routes/admin/` | права портала: страница `/admin` для администратора Битрикс24, коды доступа через `user.access`, настройки в Redis по `member_id` — `docs/ACCESS.md` |
| `server/lib/manifest.ts`, `server/plugins/module-tools.ts` | инструменты модулей портала из манифеста (`MODULE_MANIFESTS`), запись — только `WRITE_USERS` — `docs/MODULE_TOOLS.md` |
| `server/utils/services.ts` | синглтоны: конфиг, Redis/память, `B24`, `OAuthServer` |
| `tests/` | `e2e.test.ts` — весь путь на собранном сервере против `fake-b24.mjs` (в CI без сборки падает); `oauth.test.ts` — защитные проверки OAuth и `B24` с подставным временем и fetch; `lib.test.ts`; `repo.test.ts` — гарды |
| `smoke/observe.mjs` | живое наблюдение на тестовом портале через вебхук из `.env.b24test` (`npm run smoke`, не в CI) — `docs/SMOKE.md` |
| `stand/` | стенд в Docker: сервер + Redis + подставной портал (`node stand/try.mjs`), профиль `box` — коробка — `docs/STAND.md` |
| `deploy/bitrixvm/` | `Makefile`, `mcp-deploy.sh` (выкат опросом git), `nginx-mcp.conf` — `docs/DEPLOY_BITRIXVM.md` |

## Конвенции

- **Кто вызывает — только из токена.** Инструмент никогда не берёт ID сотрудника или портал из аргументов;
  `b24Call()` берёт его из сессии. Обход прав Битрикс24 недопустим — в этом смысл схемы.
- **Узкие инструменты, не «вызвать любой метод».** Встроенные — с `annotations: READ_ONLY`
  (гард в `tests/repo.test.ts`). Инструменты модулей — только методы вендора манифеста, только ключи из схемы,
  запись и удаление — только `WRITE_USERS`; манифесты задаёт администратор, модули доверенные. Запись — шаг 5 плана: отдельный список сотрудников,
  подтверждение, журнал «было/стало».
- **Персональные данные.** В журнал — только имена аргументов, не значения; ответы REST не логируем.
  Токены Битрикс24 — только в Redis, refresh — зашифрован `ENCRYPTION_KEY`.
- **Порт — только `127.0.0.1`**, у Redis портов нет (гард в `tests/repo.test.ts`).
- **mcp-toolkit молодой** (0.24.2, версии закреплены точно): OAuth в нём нет, свои 404 на
  `/.well-known/*` он ставит сам — поэтому метаданные отдаёт middleware, а не маршрут.
- **Поведение Битрикс24 — по документации и живому порталу**, не по памяти. Документация — локальный клон
  официальной `bitrix-tools/b24-rest-docs` в `.bitrix-docs/` (`npm run docs:bitrix`, в git не попадает):
  перед кодом с REST-методом — `rg` по `.bitrix-docs/b24-rest-docs/api-reference/`, в PR — путь к статье.
  MCP `b24-dev-mcp` — то же, быстрее. Не выдумывать методы, параметры, поля; устаревшие методы
  (DEPRECATED) не брать, если есть замена. Документация расходится с живым порталом — прав портал,
  расхождение записать (`docs/OAUTH_CHECK.md`, комментарий у кода). Подставной `tests/fake-b24.mjs`
  повторяет только проверенное.
- **Язык** — `docs/AGENT_RULES.md` §0: код по-английски; комментарии, документы, коммиты, PR — по-русски.
- **Штамп `> Last reviewed: YYYY-MM-DD`** под заголовком каждого `.md` (проверяет `tests/repo.test.ts`).
- **Откат мутации — из копии**, не `git checkout --`.
