# Инструменты своего модуля

> Last reviewed: 2026-10-14

Модуль коробки (или приложение облака) отдаёт свои функции ИИ без правки MCP-сервера: регистрирует
обычные REST-методы и **манифест** — метод, который описывает их как инструменты. Сервер на каждого
сотрудника читает манифест его токеном и показывает модели эти функции отдельными инструментами.

## Как это работает

1. Модуль регистрирует методы через событие `rest` → `OnRestServiceBuildDescription` (как модули
   ядра, например `calendar`) в своей области прав, например `shef_kb`.
2. Один из методов — манифест, например `shef.mcp.tools`: список инструментов.
3. В `.env` сервера: `MODULE_MANIFESTS=shef.mcp.tools` (можно несколько через запятую).
4. Сотрудник открывает ИИ-клиент → сервер зовёт `shef.mcp.tools` **его** токеном (кеш 5 минут) →
   модель видит `kb_search`, `kb_get`… → вызов идёт в названный REST-метод тем же токеном.

Права проверяет модуль, как в любом REST-методе: вызов идёт от имени сотрудника, `$USER` — он.
Модуль может отдавать разным сотрудникам разный манифест (например, без `kb_delete` тем, кому нельзя).

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
| `input` | JSON Schema объекта, до 8000 знаков. Сервер проверяет аргументы по ней **до** вызова портала |
| `title` | необязательно, подпись для человека |

Плохая запись пропускается, остальные работают; причина — в журнале сервера (`"kind":"manifest"`).

**Запись и удаление** (`write`, `delete`) видны только сотрудникам из `WRITE_USERS` (формат как
`ALLOWED_USERS`; пусто — никому). Клиент получает пометку «не только чтение» / «разрушающее» и
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

use Bitrix\Rest\RestException;

class Rest
{
    public static function onRestServiceBuildDescription(): array
    {
        return [
            'shef_kb' => [                       // область прав: её нужно выдать приложению
                'shef.mcp.tools' => [__CLASS__, 'tools'],
                'shef.kb.search' => [__CLASS__, 'search'],
                'shef.kb.get'    => [__CLASS__, 'get'],
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
        if (Access::canDelete($GLOBALS['USER']->GetID())) {
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
        $limit = min(50, max(1, (int)($query['limit'] ?? 20)));
        return Article::searchForUser((string)$query['query'], $GLOBALS['USER']->GetID(), $limit);
    }

    public static function delete(array $query, $nav, \CRestServer $server): bool
    {
        $id = (int)($query['id'] ?? 0);
        if (!Access::canDelete($GLOBALS['USER']->GetID(), $id)) {
            throw new RestException('Нет права', 'ACCESS_DENIED', \CRestServer::STATUS_FORBIDDEN);
        }
        return Article::delete($id);
    }
}
```

`Article` и `Access` — ваш код. «Не найдено» отдавайте с `\CRestServer::STATUS_NOT_FOUND` и
описанием `Not found` — сервер покажет модели «Не найдено», а не сбой.

## Чек-лист подключения

1. Модуль установлен, методы видны: `/rest/shef.mcp.tools` под администратором.
2. **Область `shef_kb` выдана приложению**, через которое входят сотрудники (локальное приложение →
   права; приложение партнёрского кабинета — в его настройках). Без неё портал ответит
   `insufficient_scope` (`rest/classes/general/rest.php`, `checkAuth`), и инструментов не будет.
   Сотрудникам после этого — войти заново (новые права приходят с новым токеном).
3. `MODULE_MANIFESTS=shef.mcp.tools`, для записи — `WRITE_USERS`, перезапуск сервера.
4. В журнале нет `"kind":"manifest"` с ошибками; в клиенте видны новые инструменты.

Не проверено на живой коробке: видна ли своя область модуля в списке прав локального приложения —
сверить на стенде (шаг 2).
