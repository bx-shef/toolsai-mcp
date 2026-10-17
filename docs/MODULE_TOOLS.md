# Инструменты своего модуля

> Last reviewed: 2026-10-17

Модуль коробки (или приложение облака) отдаёт свои функции ИИ без правки MCP-сервера: регистрирует
обычные REST-методы и **манифест** — метод, который описывает их как инструменты. Сервер на каждого
сотрудника читает манифест его токеном и показывает модели эти функции отдельными инструментами.

## Как это работает

1. Модуль регистрирует методы через событие `rest` → `OnRestServiceBuildDescription` (как модули
   ядра, например `calendar`) в своей области прав, например `shef_kb`.
2. Один из методов — манифест, например `shef.mcp.tools`: список инструментов.
3. Администратор портала вписывает `shef.mcp.tools` в «Модули портала» на `<PUBLIC_URL>/admin` ([`ACCESS.md`](ACCESS.md)); запасной путь — `MODULE_MANIFESTS` в `.env` сервера.
4. Сотрудник открывает ИИ-клиент → сервер зовёт `shef.mcp.tools` **его** токеном (кеш 5 минут) →
   модель видит `kb_search`, `kb_get`… → вызов идёт в названный REST-метод тем же токеном.

Права проверяет модуль, как в любом REST-методе: вызов идёт от имени сотрудника, `$USER` — он.
Модуль может отдавать разным сотрудникам разный манифест (например, без `kb_delete` тем, кому нельзя);
отзыв права в манифесте доходит до клиента за 5 минут (кеш), проверка в самом методе — сразу.

## Доверие

Тексты манифеста (`description`, `title`) читает модель — значит, модуль может ей «подсказывать».
Поэтому `MODULE_MANIFESTS` задаёт **администратор сервера** и только для своих, доверенных модулей.
Сервер со своей стороны:
- манифест может назвать только методы **своего вендора** (`shef.mcp.tools` → `shef.*`). Внутри
  вендора границы нет: манифест `shef.*` может назвать и `shef.toolsai.*` — это ваши же модули;
- вырезает из текстов управляющие и bidi-символы, заголовок — в одну строку;
- запись и удаление — только `WRITE_USERS`, с пометками для подтверждения человеком;
- методу уходят **только ключи из `input.properties`**: лишние (`filter`, `start`, что модуль читает
  сверх схемы) отбрасываются, `auth`, `access_token` и ключи на `_` — всегда;
- манифест ждёт не дольше 3 секунд: медленный модуль остаётся без инструментов в этот раз, встроенные
  работают. «Модуля нет» и «нет права» помнит минуту, прочие сбои не помнит.

## Манифест

```json
[
  {
    "name": "kb_search",
    "title": "Поиск по базе знаний",
    "description": "Ищет статьи базы знаний по словам. Возвращает id, заголовок, раздел, дату.",
    "method": "shef.kb.search",
    "kind": "read",
    "input": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Слова для поиска" },
        "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
      },
      "required": ["query"]
    }
  },
  {
    "name": "kb_delete",
    "description": "Удаляет статью базы знаний по id.",
    "method": "shef.kb.delete",
    "kind": "delete",
    "input": { "type": "object", "properties": { "id": { "type": "integer" } }, "required": ["id"] }
  }
]
```

Можно и `{ "tools": [ ... ] }`.

| Поле | Правило |
|---|---|
| `name` | латиница в нижнем регистре, цифры, `_`, 2–48 знаков; не имя встроенного инструмента |
| `description` | обязательно, до 1000 знаков: по нему модель решает, **когда** звать. Писать, что делает и что возвращает |
| `method` | REST-метод **того же вендора**, что и манифест (`shef.mcp.tools` → только `shef.*`), не сам манифест |
| `kind` | `read` (по умолчанию), `write` (создать, изменить), `delete` |
| `input` | JSON Schema объекта, до 8000 знаков, без `$ref`/`$defs`. Сервер проверяет аргументы по ней **до** вызова портала, лишние ключи отбрасывает |
| `title` | необязательно, подпись для человека |

Плохая запись пропускается, остальные работают; причина — в журнале сервера (`"kind":"manifest"`).
Одно имя в двух модулях — работает первый, второй в журнал.

**Запись и удаление** (`write`, `delete`) видны только тем, кому администратор портала открыл запись на `/admin`
(пусто — только администраторам) или кто есть в `WRITE_USERS` сервера. Клиент получает пометку «не только чтение» / «разрушающее» и
спрашивает человека перед вызовом. Журнал: `"tool":"module:kb_delete"`, имена аргументов.

**Ответ метода** уходит модели как JSON. Пишите его для модели: нужные поля, без HTML (предпросмотр —
текстом или ссылкой на страницу), списки — до 50 записей с `next`/`total`, как в REST ядра.

## Пример модуля (PHP)

Регистрация в установщике:

```php
\Bitrix\Main\EventManager::getInstance()->registerEventHandler(
    'rest', 'OnRestServiceBuildDescription', 'shef.kb', \Shef\Kb\Rest::class, 'onRestServiceBuildDescription'
);
```

Класс:

```php
namespace Shef\Kb;

use Bitrix\Main\Engine\CurrentUser;
use Bitrix\Rest\RestException;

class Rest
{
    public static function onRestServiceBuildDescription(): array
    {
        return [
            'shef_kb' => [                       // область прав: её нужно выдать приложению
                'shef.mcp.tools' => [__CLASS__, 'tools'],
                'shef.kb.search' => [__CLASS__, 'search'],
                'shef.kb.delete' => [__CLASS__, 'delete'],
            ],
        ];
    }

    /** Манифест: можно учитывать права текущего сотрудника. */
    public static function tools(array $query, $nav, \CRestServer $server): array
    {
        $tools = [[
            'name' => 'kb_search',
            'description' => 'Ищет статьи базы знаний по словам. Возвращает id, заголовок, раздел.',
            'method' => 'shef.kb.search',
            'kind' => 'read',
            'input' => ['type' => 'object', 'required' => ['query'], 'properties' => [
                'query' => ['type' => 'string'],
                'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50],
            ]],
        ]];
        if (Access::canDelete((int)CurrentUser::get()->getId())) {
            $tools[] = [
                'name' => 'kb_delete', 'description' => 'Удаляет статью по id.', 'method' => 'shef.kb.delete',
                'kind' => 'delete',
                'input' => ['type' => 'object', 'required' => ['id'], 'properties' => ['id' => ['type' => 'integer']]],
            ];
        }
        return $tools;
    }

    public static function search(array $query, $nav, \CRestServer $server): array
    {
        $text = trim((string)($query['query'] ?? ''));
        if ($text === '') {
            throw new RestException('Нужен query', 'INVALID_ARG_VALUE', \CRestServer::STATUS_WRONG_REQUEST);
        }
        $limit = min(50, max(1, (int)($query['limit'] ?? 20)));
        return Article::searchForUser($text, (int)CurrentUser::get()->getId(), $limit);
    }

    public static function delete(array $query, $nav, \CRestServer $server): bool
    {
        $id = (int)($query['id'] ?? 0);
        if (!Access::canDelete((int)CurrentUser::get()->getId(), $id)) {
            throw new RestException('Нет права', 'ACCESS_DENIED', \CRestServer::STATUS_FORBIDDEN);
        }
        return Article::delete($id);
    }
}
```

`Article` и `Access` — ваш код. «Не найдено» отдавайте с `\CRestServer::STATUS_NOT_FOUND` и
описанием `Not found` — сервер покажет модели «Не найдено», а не сбой.

Прочий отказ модуля (HTTP 4xx с кодом ошибки) модель видит кодом **и текстом**
(`error_description`, без управляющих символов, в одну строку, до 300 знаков):
`Битрикс24 отказал: INVALID_ARG_VALUE — Выберите сотрудников или отделы.` Текста нет или он
равен коду — только код. Сетевые сбои и отказы самого сервера — только код, без текста (в нём
бывают адреса и IP). У встроенных инструментов текст ядра не показывается никогда.

Текст отказа читает модель — пишите его для неё: что исправить в запросе. Без внутренних
подробностей (пути, SQL), без персональных данных и без эха ввода пользователей (заголовок
чужой статьи в тексте ошибки — канал подсказок модели от других сотрудников). Отказ самого REST
портала (например `insufficient_scope`) модель тоже увидит текстом ядра.

## Чек-лист подключения

1. Модуль установлен, методы видны: `/rest/shef.mcp.tools` под администратором.
2. **Область `shef_kb` выдана приложению**, через которое входят сотрудники (локальное приложение →
   права; приложение партнёрского кабинета — в его настройках). Без неё портал ответит
   `insufficient_scope` (`rest/classes/general/rest.php`, `checkAuth`), и инструментов не будет.
   Сотрудникам после этого — войти заново (новые права приходят с новым токеном).
3. `MODULE_MANIFESTS=shef.mcp.tools`, для записи — `WRITE_USERS`, перезапуск сервера.
4. В журнале нет `"kind":"manifest"` с ошибками; в клиенте видны новые инструменты.

Не проверено на живой коробке (сверить на стенде): пример PHP целиком и то, видна ли своя область
модуля в списке прав локального приложения (шаг 2). Форма описания методов и сигнатура колбэка — по
коду ядра (`calendar/classes/general/calendar_restservice.php`, `rest/classes/general/rest.php`).
