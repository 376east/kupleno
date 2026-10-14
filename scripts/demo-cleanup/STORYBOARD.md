---
format: 1920x1080
duration: 43s
fps: 30
mode: autonomous
music: none
message: Покупки на маркетплейсах по вещам и чекам
---

## Video direction

Тёплый фон #faf9f6, угольный текст #292b27, сдержанный зелёный #385a46. Локальные Golos regular/bold из `repo/extension/fonts`, лицензия в `assets/fonts/OFL.txt`. Неподвижный реальный UI справа, подпись слева. Только 0,25 с opacity дочерних слоёв на входе; остальное время для чтения. Одна композиция `index.html`.

## Frame 1 - Куплено
- status: animated
- duration: 4s
- transition_in: cut
- scene: Покупки на маркетплейсах - по вещам и чекам

0–4 с. Крупное название и описание, выровненные по левому краю.

## Frame 2 - Сколько потрачено
- status: animated
- duration: 9s
- transition_in: cut
- scene: Покупки и возвраты за выбранный период

4–13 с. `assets/overview.png`. Сумма остаётся точной в подлинном снимке. Источник: текущие снимки в `assets/demo/scenes`, 13 вымышленных операций.

## Frame 3 - Найти покупку
- status: animated
- duration: 4s
- transition_in: cut
- scene: Поиск и фильтр по магазину

13–17 с. `assets/purchases.png`. Источник: текущие снимки в `assets/demo/scenes`, 13 вымышленных операций.

## Frame 4 - Посмотреть детали
- status: animated
- duration: 5s
- transition_in: cut
- scene: Дата, сумма, категория и заметка

17–22 с. `assets/details.png`. Источник: текущие снимки в `assets/demo/scenes`, 13 вымышленных операций. Открытый чек не заявляется.

## Frame 5 - История в одном браузере
- status: animated
- duration: 8s
- transition_in: cut
- scene: Ozon, Wildberries, Яндекс Маркет

22–30 с. `assets/stores.png`. Источник: текущие снимки в `assets/demo/scenes`, 13 вымышленных операций. Это обзор магазинов, не демонстрация живого сбора.

## Frame 6 - Бюджет на месяц
- status: animated
- duration: 4s
- transition_in: cut
- scene: Расходы за месяц и выбранный бюджет

30–34 с. `assets/control.png`. Источник: текущие снимки в `assets/demo/scenes`, 13 вымышленных операций.

## Frame 7 - Ожидаемые возвраты
- status: animated
- duration: 4s
- transition_in: cut
- scene: Покупки, по которым ожидается возврат

34–38 с. `assets/returns.png`. Подлинный экран ожиданий возврата из `assets/demo/scenes/returns.png`, на вымышленных данных.

## Frame 8 - Данные хранятся в браузере
- status: animated
- duration: 5s
- transition_in: cut
- scene: Демонстрационные данные. Живой сбор не показан.

38–43 с. Крупный спокойный финал. Заметка о демонстрационных данных видна с 4-й секунды до конца.
