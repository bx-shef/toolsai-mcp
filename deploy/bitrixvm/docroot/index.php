<?php
// Заглушка каталога сайта MCP-сервера в /home/bitrix/ext_www/<домен> (раздел «Свой домен»).
// Сюда запрос доходит, только если сломалось проксирование nginx → контейнер. Логики здесь нет:
// каталог исполняет PHP портала, любой код тут работал бы рядом с боевым Битрикс24.
// 503, а не 200: сервис не обслуживается — не врать мониторингу.
http_response_code(503);
header('Content-Type: text/plain; charset=utf-8');
header('Retry-After: 60');
header('X-Robots-Tag: noindex, nofollow');
echo "Service is temporarily unavailable\n";
