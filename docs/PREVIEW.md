# Предпросмотр 0.22.0: запуск, данные и проверки

Статус: самостоятельная MV3-сборка, работающая локально в Chromium. Серверной части нет. Версия и зависимости зафиксированы в [package.json](../extension/next/package.json) и [lockfile](../extension/next/package-lock.json). Старые документы в этой папке описывают 0.19.2, если явно не сказано иное.

Оба поля версии установленного расширения берутся из package.json: `version` и `version_name` с пометкой preview. Проверка готового manifest входит в `preview:check`; браузерный сценарий сверяет версию через `chrome.runtime.getManifest()`. [Конфигурация](../extension/next/wxt.config.ts), [проверка сборки](../scripts/check-preview-version.cjs), [проверка установки](../scripts/next-browser-smoke.cjs).

## Запуск

Нужен Node.js 24, npm и Chromium с поддержкой MV3/offscreen. Минимальная версия браузера в [конфигурации](../extension/next/wxt.config.ts) - 116; проверки проводятся на тестовом Chromium, а не на всех версиях от 116. `.nvmrc` в корне относится к прежней сборке и не подходит для нового WXT.

```sh
npm ci
npm --prefix extension/next ci
npx playwright install chromium
npm run preview:check
npm run preview:browser
```

На Linux для системных зависимостей браузера: `npx playwright install --with-deps chromium`. Для кастомного Chrome задайте `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Нужен браузер, допускающий загрузку unpacked-расширений; обычный брендированный Chrome может ограничивать запуск через флаги. Скрипты создают отдельный временный профиль. [UI smoke](../scripts/next-browser-smoke.cjs), [сбор](../scripts/next-collection-smoke.cjs).

Для ручной установки выберите `extension/next/.output/chrome-mv3` на странице расширений. Для разработки: `npm --prefix extension/next run dev`. После замены production-сборки обновите расширение и его вкладку. Не подменяйте установленную папку без резервной копии.

Переменных окружения приложения и API-ключей нет. [.env.example](../.env.example) перечисляет только необязательные пути тестов; приложение не читает этот файл автоматически. Root `npm ci` устанавливает инструменты проверок, второй `npm ci` - зависимости WXT/React. Общие PDF.js и шрифты берутся из `extension/vendor` и `extension/fonts`, поэтому `extension/next` нельзя переносить отдельно от репозитория. [PDF loader](../extension/next/collectors/pdf.ts), [CSS](../extension/next/ui.css).

## Точки входа

| Часть | Где искать | Ответственность |
| --- | --- | --- |
| Сборка/разрешения | [wxt.config.ts](../extension/next/wxt.config.ts), [collection.ts](../extension/next/collection.ts) | MV3, CSP, optional host permissions, типы сообщений |
| Страница | [app/main.tsx](../extension/next/entrypoints/app/main.tsx), [App.tsx](../extension/next/ui/App.tsx) | Загрузка базы, маршруты по hash, фильтры, импорт, редактор |
| Фоновый обработчик | [background.ts](../extension/next/entrypoints/background.ts), [worker/collection.ts](../extension/next/worker/collection.ts) | Единственное задание сбора, вкладки, права отправителя, статусы |
| Offscreen | [offscreen/main.ts](../extension/next/entrypoints/offscreen/main.ts) | Ozon/Яндекс, PDF worker, progress/finished, отмена |
| Магазины в UI | [Stores.tsx](../extension/next/ui/Stores.tsx) | Разрешения, polling, сохранение результата до ACK, очистка магазина |
| Парсеры | [collectors](../extension/next/collectors/) | Списки, PDF/HTML, сверка чеков, неполные результаты |
| Хранение | [storage.mjs](../extension/next/storage.mjs), [model.ts](../extension/next/model.ts) | IndexedDB, backup, история и CAS |
| Расчёты | [domain.mjs](../extension/next/domain.mjs), [preferences.mjs](../extension/next/preferences.mjs) | Копейки, фильтрация, слияние, ручные правки |
| Категории и анализ | [categories.ts](../extension/next/categories.ts), [intelligence.ts](../extension/next/intelligence.ts) | Локальный словарь, правила, кандидаты на проверку |
| Бюджет и документы | [lifecycle.ts](../extension/next/lifecycle.ts), [Control.tsx](../extension/next/ui/Control.tsx) | Возвраты, гарантии, бюджеты, снимок месяца |

Часть ядра остаётся JavaScript с `.d.mts`, а не полностью проверяемой TypeScript-реализацией. Декларации не заменяют runtime-проверку JSON. [storage.d.mts](../extension/next/storage.d.mts), [storage.mjs](../extension/next/storage.mjs).

## Путь данных

1. `Stores` запрашивает optional permissions выбранного магазина и отправляет `KUPLENO_JOB/start` с source/profile.
2. `worker/collection` сериализует команды, создаёт свою неактивную вкладку и сохраняет Job в `chrome.storage.local` под `kupleno-next-job`. Успех, ошибка и отмена закрывают служебную вкладку, если пользователь не ушёл на другую страницу. Старые пользовательские вкладки не принадлежат заданию.
3. WB выполняется в background; Ozon и Яндекс - через offscreen. Запросы Яндекса привязаны к вкладке задания; список Ozon читается из ISOLATED world, PDF запрашивается background. Только фиксированные разрешённые endpoint/домены, не произвольные URL. [Ozon bridge](../extension/next/worker/ozon-request.ts), [PDF](../extension/next/worker/ozon-pdf.ts), [Яндекс](../extension/next/worker/yandex-request.ts).
4. Парсер возвращает `CollectionResult`: rows, stats, warnings и обработанные чеки. На несовпадении состава может сохраниться только итог с `parse_quality=fallback`. Частичный результат не является полной новой историей.
5. Завершённый Job остаётся в `storage.local`, пока UI не сохранит объединённую историю транзакцией IndexedDB. `lastAppliedCollection` предотвращает повторное применение; ACK очищает Job. [Реализация](../extension/next/ui/Stores.tsx).

Контракт `KUPLENO_JOB` разрешает start/status/cancel/ack; события offscreen - progress/finished. Проверяется sender extension ID и URL документа. Изменения протокола требуют проверки клиента и обработчика, включая повторное открытие UI и отмену. [Контракт](../extension/next/collection.ts), [проверка обеих сторон](../scripts/next-collection-smoke.cjs).

Внешние API маркетплейсов не являются нашим стабильным публичным API. Их форма может поменяться. WB использует собственную сессию сайта; она не должна попасть в Job/backup/логи. У Яндекса четыре параллельных запроса заказов и четыре загрузки чеков; PDF Ozon пока идут последовательно. [WB](../extension/next/collectors/wildberries.ts), [Яндекс](../extension/next/collectors/yandex-collect.ts), [Ozon](../extension/next/collectors/ozon-collect.ts).

## Данные

`Purchase` содержит rowId, date, source, title, amount и необязательные category/profile/type/receipt_url/parse_quality. Схема допускает неизвестные поля ради round-trip. Сумма в строке операции - decimal, арифметика выполняется в целых копейках. Не путать одинаковую сумму с идентичностью операции. [Модель](../extension/next/model.ts), [арифметика](../extension/next/domain.mjs).

База `kupleno-storage-v2`: stores current/history/meta. Оболочка `{state, revision, epoch}`; запись требует ожидаемые revision/epoch, чтобы не затереть изменения другой вкладки. Сохраняются последние 12 состояний. Backup v1/v2 читается с проверкой структуры и опасных ключей. [storage.mjs](../extension/next/storage.mjs), [тесты](../extension/next/storage.test.mjs).

Миграция читает `kupleno-storage-v1` и копирует состояние, не изменяя старую базу. Она возможна только внутри того же extension origin; новая установка с другим ID не увидит чужую базу. Для неё нужен явный импорт JSON. Удаление истории магазина сохраняет остальные магазины и убирает связанные ручные записи. [App initialization](../extension/next/ui/App.tsx), [source-data.ts](../extension/next/source-data.ts).

Объединение профиля сначала показывает подтверждение: покупки, ручные правки и документы перейдут в первый оставшийся профиль. Бюджеты, итоги месяцев и отметки проверки удаляемого профиля не переносятся; их удаление явно показано до записи. Отмена и Escape сохраняют прежнее состояние. [Preferences](../extension/next/ui/Preferences.tsx), [проверка](../scripts/next-browser-smoke.cjs).

История чеков и настройки не отправляются на сервер продукта. При живом сборе выполняются запросы к выбранному маркетплейсу с его браузерной сессией. Это не офлайн-сбор. Озвучка демо - отдельный инструмент разработчика, не код расширения. [Offscreen](../extension/next/entrypoints/offscreen/main.ts), [DEMO](DEMO.md).

## Проверки и пробелы

- `npm run preview:check`: типы, unit-тесты, production build и ссылки документов. [Команды](../package.json).
- `npm run preview:browser`: настоящий unpacked MV3 в отдельном Chromium, импорт, поиск, редактирование, PDF worker, повторное открытие, backup/restore, возврат, гарантия, бюджет; отдельный проход worker/offscreen с искусственными ответами магазинов. Это не авторизованные аккаунты. [UI test](../scripts/next-browser-smoke.cjs), [collection test](../scripts/next-collection-smoke.cjs).
- `KUPLENO_DESIGN_OUTPUT` + `npm run preview:design`: synthetic history, светлая/тёмная темы, поиск, карточка, пять разделов на 390 px, Control на 320 px. Полного аудита скринридером нет. [Сценарий](../scripts/next-design-demo.cjs).
- CI запускает эти проверки после push в `main`, на PR и вручную; push в рабочую ветку отдельно CI не запускает. Полное декодирование MP4 и границы реплик проверяет сценарий озвучки. [Workflow](../.github/workflows/ci.yml), [озвучка](../scripts/demo-voice.py).

Импорт отклоняет повреждённые поля правил категорий и месячных бюджетов до записи; допустимые неизвестные JSON-поля сохраняются. У бюджета разрешён отсутствующий или `null` общий лимит; старые плоские лимиты не преобразуются. Проверка отказа записи и импорта без изменения базы: [storage tests](../extension/next/storage.test.mjs), [UI scenario](../scripts/next-browser-smoke.cjs).

Списки ручных привязок возвратов содержат уникальные непустые ID операций; явные ID ожиданий тоже уникальны. Импорт и запись отклоняют повреждённые списки. Финансовая сверка дополнительно помечает общую операцию спорной, даже если ожидания имеют одинаковый ID. Это не подтверждает полноту живых возвратов. [Lifecycle tests](../extension/next/lifecycle.test.ts), [storage tests](../extension/next/storage.test.mjs).

Если старая сохранённая база не проходит новые проверки, интерфейс открывает восстановление. `readRecovery()` отдаёт исходный JSON для скачивания и revision/epoch целевой базы, без загрузки повреждённых настроек в обычные экраны. Если v2 ещё пуста, исходная копия читается из v1 без изменения старой базы. Исправный импорт и валидный снимок проходят обычную строгую проверку и CAS; отмена ничего не записывает. Перед заменой сохраните исходный файл. [Storage](../extension/next/storage.mjs), [App](../extension/next/ui/App.tsx), [unit](../extension/next/storage.test.mjs), [браузер](../scripts/next-browser-smoke.cjs).

Сохранённые итоги месяцев: импорт и запись отклоняют повреждённые контейнеры, статус и сумму netSpend до изменения базы. Отсутствующие/null-итоги остаются читаемыми и показываются как недоступные; отрицательные суммы возвратов и неизвестные поля сохраняются. Проверяются только месячные записи с ключом профиля и месяца, используемые экраном бюджета. Прочие поля снимка ещё не проверены. [Storage tests](../extension/next/storage.test.mjs), [отказ импорта без изменения базы](../scripts/next-browser-smoke.cjs).

Выбранный профиль dataProfile должен существовать и иметь ID не длиннее 120 символов, как требует [сборщик](../extension/next/worker/collection.ts); activeProfile допускает также all. Повреждённый выбор отклоняется до импорта/записи, чтобы CSV и сбор не получали несуществующий профиль. Отсутствующий выбор и пустые списки профилей сохраняют прежний профиль по умолчанию; исходные настройки не дописываются при чтении. [Storage tests](../extension/next/storage.test.mjs), [браузерный отказ импорта](../scripts/next-browser-smoke.cjs).

Известные незакрытые вопросы: живой Ozon после смены транспорта PDF; полнота Яндекса при повторе токена и отсутствии ссылки чека; финансовая эквивалентность старому сборщику на полном корпусе; остальные вложенные поля settings; связи профиля с бюджетами при удалении. Это задачи проверки, а не обещание корректности. Приоритеты и критерии - в [PLAN](../PLAN.md).

## Публикация

Готовая сборка WXT находится в `extension/next/.output/chrome-mv3` и не хранится в Git. Старый `npm run package` не включает `next`. Для установки соберите предпросмотр локально или запустите [CI](../.github/workflows/ci.yml) вручную с `keep_artifacts=true`: архив `kupleno-preview-<SHA>` сохраняется на 7 дней. Обычный запуск CI сохраняет результаты в логах без артефактов.

Стабильный релиз и публикация в магазине расширений требуют отдельного решения. Перед выпуском проверьте точный commit, набор файлов и CI. [Процесс выпуска прежней реализации](../RELEASE.md).

## Откат основной ветки

С 4 октября 2026 основной вход `main` - предпросмотр; текущая версия - [0.22.0](../extension/next/package.json). Это смена исходников по умолчанию, а не подтверждение стабильности сборщиков. Старый опубликованный HEAD `258e8272559c69f72f99c27911b4bc71c5a42303` сохранён тегом `archive/pre-021-20261004`.

Чтобы вернуть прежнюю основную ветку без force-push и удаления истории, создайте архивную ветку и сделайте её основной:

```sh
git fetch origin --tags
git push origin refs/tags/archive/pre-021-20261004:refs/heads/archive/legacy-0192
gh api --method PATCH repos/malyarq/kupleno -f default_branch=archive/legacy-0192
```

Последняя команда требует уже авторизованного `gh`; альтернатива - GitHub Settings → Default branch → `archive/legacy-0192`. Новая история остаётся в `main`. Это откат репозитория, не локальной базы: перед заменой расширения экспортируйте JSON. Не открывайте новую базу старым кодом без проверки совместимости.


## Перенос интерфейса прототипов

Обзор сохраняет настоящую историю, фильтры, месяцы, категории и крупные покупки. Новый график Recharts 3.10.1 показывает накопленные расходы по полным датам; возвраты, исключённые операции и валюты обрабатываются существующим финансовым ядром. Все вычисления остаются в целых копейках. Для клавиатуры и точного чтения рядом есть раскрываемая таблица. Видимы последние 90 дат с операциями; накопленный итог считается с начала выбранного периода. Неверные даты явно отмечены. [Компонент](../extension/next/ui/SpendingChart.tsx), [агрегация](../extension/next/spending-series.mjs), [регрессии](../extension/next/spending-series.test.mjs).

Motion 14.6.0 подчёркивает обновление главной суммы; AutoAnimate 0.10.0 сохраняет пространственную связь строк крупных покупок при фильтрации. Оба эффекта учитывают reduced motion. Recharts загружается отдельным ленивым чанком только при непустом обзоре. [UI](../extension/next/ui/App.tsx), [точные версии](../extension/next/package.json), [уведомления](../extension/next/public/licenses/UI-THIRD-PARTY-NOTICES.txt).

Синтетический localStorage-журнал, упрощённый импорт, фиктивные HTML-чеки и настройки из прототипа не подменяют IndexedDB, историю изменений, проверку резервных копий и действующие сборщики. Radix/Sonner/Paper Shaders не добавлены поверх собственных dialog/уведомлений и обычной поверхности продукта.
