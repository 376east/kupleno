# Демо Куплено

[Текущий ролик 0.22.0](../assets/demo/kupleno-demo.mp4) - 43 секунды, 1920×1080, 30 кадров в секунду. Без звука: короткие подписи и настоящие экраны расширения. В кадрах 13 вымышленных операций. Живой сбор не запускается и не показан.

## Пересобрать текущую демку

Сначала соберите приложение и сделайте снимки, как в [PREVIEW](PREVIEW.md#запуск):

```powershell
$env:KUPLENO_DESIGN_OUTPUT = Join-Path (Get-Location) '../outputs/design-cleanup'
npm run preview:check
npm run preview:design
```

[Сценарий снимков](../scripts/next-design-demo.cjs) запускает настоящий MV3 в отдельном временном профиле. Он сохраняет светлые кадры overview, purchases, details, stores, control и returns. Суммы в ролике берутся из этих экранов; финансовые операции пользователя не читаются.

Чтобы использовать новые кадры, замените одноимённые PNG в `assets/demo/scenes`. Затем подготовьте отдельный проект:

```powershell
node scripts/prepare-demo.cjs
```

Команда выводит путь к проекту в `../work/demo-composition`. Внутри него:

```powershell
npm run check
npm run dev -- --background
npm run render -- --output kupleno-demo.mp4
```

На проверенном Windows HyperFrames 0.8.156 не проходит собственный запуск `Chrome --version`, хотя check и snapshot работают. Для этой композиции, где внутри сцен нет движения кроме проявления за 0,25 секунды, используйте проверенный путь:

```powershell
npx --yes hyperframes@0.8.156 snapshot --at 2,8,15,20,26,32,36,40 --no-end --output frames
python render-demo.py --frames frames --output kupleno-demo.mp4
```

[Локальный кодировщик](../scripts/render-demo.py) сохраняет длительности сцен и проявления, проверяет 1920×1080, 30 fps, 43 секунды и полное декодирование файла. Он рассчитан на текущие восемь неподвижных сцен; при добавлении движения используйте полноценный рендер HyperFrames.

[Исходная композиция](../scripts/demo-cleanup/index.html), [сценарий](../scripts/demo-cleanup/STORYBOARD.md) и [параметры](../scripts/demo-cleanup/package.json) сохранены в репозитории. HyperFrames зафиксирован на 0.8.156; команда загружает CLI через npm, а композиция использует GSAP с CDN. Шрифты Golos и их лицензия копируются локально. На Windows для тестового Chrome можно задать `HYPERFRAMES_BROWSER_PATH`, аналогично `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` из PREVIEW. Перед рендером просмотрите все сцены: автоматические проверки не подтверждают смысл подписей.

## Прежняя демка 0.21 и озвучка

Файлы ниже сохранены как прежняя версия. Тайминги её озвучки не подходят к новой 43-секундной композиции.

[Итоговый ролик 0.21.0](../assets/demo/kupleno-0.21-voice.mp4) - около 57 секунд, русский синтетический голос, только вымышленные покупки. [Исходная запись без голоса](../assets/demo/kupleno-0.21-silent.mp4) - около 30 секунд. Ни одна сцена не доказывает успешность живого сбора.

## Записать интерфейс

После установки зависимостей и `npm run preview:check` подготовьте Chromium, как в [PREVIEW](PREVIEW.md#запуск). В PowerShell из корня:

```powershell
$env:KUPLENO_DESIGN_OUTPUT = Join-Path (Get-Location) 'work/demo-record'
node scripts/next-design-demo.cjs --record
```

В bash:

```sh
KUPLENO_DESIGN_OUTPUT="$PWD/work/demo-record" node scripts/next-design-demo.cjs --record
```

[Сценарий](../scripts/next-design-demo.cjs) запускает временный профиль, открывает настоящий unpacked MV3, импортирует встроенную вымышленную историю из 13 операций, показывает обзор, фильтры, темы, поиск, карточку, магазины и контроль. Рабочая база пользователя не открывается. Сетевой сбор не запускается. У магазина не нужно запрашивать доступ. Прежняя запись 0.21 использовала 37 операций.

Запись сохраняется в `kupleno-demo.webm`. Нужны ffmpeg/ffprobe в PATH:

```sh
ffmpeg -i work/demo-record/kupleno-demo.webm -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart work/demo-record/silent.mp4
```

Отдельный запуск без `--record` делает снимки и проверяет мобильные страницы. Режим записи оставляет desktop-кадр 1440×1000; он не является отдельной мобильной демонстрацией.

## Добавить голос

Нужны Python 3.11+, ffmpeg/ffprobe с H.264/AAC и отдельное окружение. PowerShell:

```powershell
python -m venv work/demo-venv
work/demo-venv/Scripts/python.exe -m pip install -r scripts/demo-requirements.txt
work/demo-venv/Scripts/python.exe scripts/demo-voice.py
```

На Linux/macOS замените путь Python на `work/demo-venv/bin/python`. Результат по умолчанию: `work/demo-voice/kupleno-voice.mp4`. Скрипт использует опубликованный silent MP4 и [границы сцен/реплики](../scripts/demo-scenes.json), так что его можно выполнить без перезаписи браузера.

Голос - `ru-RU-SvetlanaNeural`, темп `+5%`. Edge TTS получает только текст сценария по сети; API-ключ в проекте не нужен. Доступность сервиса не гарантирована. Не подставляйте реальные чеки или личные сведения. Аудио кешируется по хешу текста, голоса и темпа. Повторная сборка без сети: `python scripts/demo-voice.py --offline` при наличии этого кеша. [Реализация](../scripts/demo-voice.py).

Каждая сцена начинается с паузы 0,3 секунды. Если голос длиннее исходного фрагмента, последний кадр удерживается; речь не ускоряется. Громкость нормализуется к -16 LUFS, пик ограничивается целевыми -2 dBTP; кодирование AAC может дать небольшое отклонение. Проверяются границы реплик, общая длительность и полное декодирование результата. Таймлайн лежит рядом с кешем в `timeline.json`.

**Ручной этап при новой записи:** просмотрите видео, обновите границы в `scripts/demo-scenes.json` и текст под новые экраны. Тайминги не определяются автоматически и могут немного отличаться на другом компьютере. Для новой записи передайте `--source work/demo-record/silent.mp4`. После монтажа проверьте, что реплики соответствуют кадрам; техническая проверка этого не понимает. Побайтная идентичность нового сетевого TTS не обещается.

В ролике нет музыки, чужих фото и записанного голоса человека. Рисунок чека - SVG из [components.tsx](../extension/next/ui/components.tsx), шрифты и их лицензии лежат в [extension/fonts](../extension/fonts/). Вымышленные названия товаров нужны для сценария, не являются рекламой или подтверждением покупки.
