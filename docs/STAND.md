# Стенд в Docker

> Last reviewed: 2026-10-16

Для тестов и проверок, не для работы: ключи тестовые, всё только на `127.0.0.1`. Файлы — `stand/`.

## Быстрый стенд: сервер + подставной Битрикс24

Сервер из исходников, Redis и подставной портал с OAuth-сервером (`tests/fake-b24.mjs` — тот же,
что в сквозных тестах). Весь путь MCP-клиента и страница `/admin` — без интернета и без портала.

```bash
cd stand
docker compose up -d --build           # образ из исходников
# или быстрее — из уже собранного .output (npm run build в корне):
docker compose -f docker-compose.yml -f docker-compose.output.yml up -d
node try.mjs                           # прогон: отказ → администратор открывает U7 → сотрудник 7 входит
docker compose down -v
```

- Сервер — `http://localhost:3000` (страница настроек `http://localhost:3000/admin`).
- Подставной портал — `http://localhost:8090`. Кто «вошёл» в портал: `POST /_state {"user": 1}`.
  Администратор — сотрудник 1; `user.access` понимает коды `AU` и `U<id>`; модуль `shef.mcp.tools`
  отдаёт `kb_search` и `kb_delete`.
- Сервер живёт в сетевом пространстве подставного портала (`network_mode: service:fake`): портал на
  `localhost` сервер принимает только при локальном `PUBLIC_URL`, как в тестах.

## Коробка Битрикс24: профиль `box`

apache + mod_php 8.2 и MySQL 8.0 — как стенд `shef.toolsai` (`bx-shef/toolsai`, `docker/`).
Для проверки своего модуля и манифеста на настоящем ядре: поставить модуль, завести входящий
вебхук и прогнать `npm run smoke` с ним в `.env.b24test` ([`SMOKE.md`](SMOKE.md)).

```bash
cd stand
docker compose --profile box up -d --build
# развернуть коробку в stand/www: restore.php с резервной копией или bitrixsetup.php
# БД для мастера: хост db, база bitrix, пользователь bitrix, пароль bitrix
```

Портал — `http://localhost:8080`. **Вход сотрудника через OAuth на коробке стенда не работает**:
токены выдаёт облачный OAuth-сервер Битрикс24, а он не достучится до `localhost`, и сервер не
пускает REST на внутренние адреса. Вход и права проверяются быстрым стендом, REST модулей — вебхуком.
