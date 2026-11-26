<img src="docs/assets/kupleno-nameplate.png" alt="Куплено" width="760">

[![CI](https://github.com/376east/kupleno/actions/workflows/ci.yml/badge.svg?branch=master&event=push)](https://github.com/376east/kupleno/actions/workflows/ci.yml) [![Stack](https://img.shields.io/badge/Stack-WXT%20%C2%B7%20React-555?style=flat)](extension/next/package.json)

**[Скачать Куплено 0.22.16](https://github.com/376east/kupleno/releases/download/v0.22.16/kupleno-extension.zip)** · [Инструкция по установке](#установка) · [Последний выпуск](https://github.com/376east/kupleno/releases/latest)

Покупки, возвраты и чеки Ozon, Wildberries и Яндекс Маркета в одном журнале. Данные хранятся в браузере.

## Установка

1. Если «Куплено» уже установлено, сначала откройте «Настройки» → «Ваши данные» → «Скачать копию». Сохраните JSON отдельно от папки расширения.
2. Скачайте и распакуйте ZIP. Откройте `chrome://extensions` в Chrome или `edge://extensions` в Edge.
3. Включите «Режим разработчика», нажмите «Загрузить распакованное расширение» и выберите папку с `manifest.json`. При обновлении замените файлы в установленной папке и нажмите «Обновить» на странице расширений.

Если при новой установке история пуста, загрузите сохранённый JSON через «Загрузить историю». Этой же кнопкой можно добавить покупки из CSV. [Резервные копии и данные](docs/PREVIEW.md#данные)

## Сбор покупок

Войдите в магазины в том же профиле браузера. Откройте «Магазины» в расширении, разрешите доступ к нужным площадкам и запустите обновление. Сбор может завершиться частично, а ранее сохранённая история останется в журнале. Полнота сбора в живых аккаунтах Яндекс Маркета ещё проверяется. [Текущая проверка полноты сбора](https://github.com/376east/kupleno/issues/23)

## Ссылки проекта

[История изменений](CHANGELOG.md) · [Поддержка](SUPPORT.md) · [MIT](LICENSE) · [Сторонние компоненты](THIRD_PARTY_NOTICES.md) · [Архив 0.22.15 Preview](https://github.com/376east/kupleno/releases/tag/v0.22.15-preview.1)
