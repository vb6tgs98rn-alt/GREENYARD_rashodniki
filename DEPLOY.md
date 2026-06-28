# Развёртывание интеграции с RealtyCalendar

Это пошаговая инструкция, как подключить новую интеграцию **RealtyCalendar → Green Yard**.
Все 4 шага обязательны и должны быть выполнены в указанном порядке.

> Архитектура: RealtyCalendar отправляет webhook → Supabase Edge Function проверяет `agency_id`
> и находит владельца по таблице `rc_integrations` → запись попадает в `rc_bookings` под нужным
> `user_id` → фронт по realtime-подписке видит новую строку и пересчитывает финансы.
>
> **Один URL — много пользователей**. Каждый клиент сервиса подключается в самом приложении,
> вводя свой `agency_id` (он уникален для каждого личного кабинета RealtyCalendar).

---

## Шаг 1. SQL-миграция в Supabase Studio

1. Откройте проект Supabase: **https://wpwuxcxmtvdxftqrrxuu.supabase.co**
2. В левом меню — **SQL Editor** → **+ New query**.
3. Скопируйте полностью содержимое файла `supabase/sql/01_realtycalendar.sql` и вставьте в редактор.
4. Нажмите **Run**.

В результате должны появиться три таблицы:
- `public.rc_integrations` — связка `user_id ↔ agency_id` (+ колонка `last_event_at`).
- `public.rc_bookings` — бронирования из RealtyCalendar (PK: `user_id` + `booking_id`).
- `public.rc_webhook_log` — лог всех входящих webhook-запросов (ошибки, действия, статусы).

Все таблицы защищены **Row Level Security**:
- пользователь видит только свои строки (`auth.uid() = user_id`);
- запись/обновление выполняет только Edge Function от имени `service_role`.

SQL-скрипт идемпотентный — его безопасно прогонять повторно.

---

## Шаг 2. Деплой Supabase Edge Function

Edge Function — это публичный эндпоинт, который принимает webhook от RealtyCalendar.

### Требования
- Установлен **Supabase CLI**: https://supabase.com/docs/guides/cli
- Терминал открыт в корне проекта (там же, где лежит папка `supabase/`).

### Команды
```bash
# Один раз: логинимся и привязываемся к проекту
supabase login
supabase link --project-ref wpwuxcxmtvdxftqrrxuu

# Деплой функции (важно: --no-verify-jwt, потому что RealtyCalendar не присылает JWT)
supabase functions deploy realtycalendar-webhook --no-verify-jwt
```

После успешного деплоя функция будет доступна по адресу:

```
https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/realtycalendar-webhook
```

> **Важно:** флаг `--no-verify-jwt` обязателен. Если его не указать, Supabase будет требовать
> заголовок `Authorization`, а RealtyCalendar его не присылает — все запросы будут падать с 401.

### Проверка
В Supabase Studio: **Edge Functions → realtycalendar-webhook → Logs**. После первого реального
вызова там должны появиться записи.

---

## Шаг 3. Заливка статики на Vercel

Все JS/HTML/CSS файлы — это статика. Их нужно просто заменить в существующем проекте на Vercel.

1. Распакуйте zip-архив `green-yard-rc-integration.zip` в локальную копию проекта,
   замещая старые файлы.
2. Закоммитьте изменения в репозиторий, который привязан к проекту
   **`greenyard-rashodniki`** на Vercel — деплой произойдёт автоматически.
3. Когда деплой завершится, откройте https://greenyard-rashodniki.vercel.app/
4. Сделайте **жёсткое обновление страницы** (`Ctrl + Shift + R` / `Cmd + Shift + R`),
   чтобы браузер не подтянул старый кэш. Все ссылки на `styles.css` и `app.js` в HTML
   помечены параметром `?v=20260628-1` — если этот параметр виден в DevTools → Network,
   значит, грузится свежая версия.

---

## Шаг 4. Подключение в самом приложении

Это шаг, который выполняет **каждый пользователь сервиса** в своём аккаунте.

1. Войдите в приложение под своим email/паролем (Supabase Auth).
2. Перейдите в раздел **Финучёт** → откройте модалку **Настройки интеграции**
   (кнопка «Настройки» в шапке финучёта).
3. **Шаг 1** в модалке: введите свой **`agency_id`** из личного кабинета RealtyCalendar
   (целое число, видно в URL личного кабинета или в разделе «Профиль агентства»)
   и нажмите **Подключить**.
   После успешного подключения статус сменится на «Подключено», поле станет неактивным,
   появится кнопка **Отключить**.
4. **Шаг 2** в модалке: скопируйте предложенный URL — это адрес Edge Function:
   ```
   https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/realtycalendar-webhook
   ```
   (для всех пользователей сервиса URL одинаковый — разделение идёт по `agency_id`).
5. Откройте **личный кабинет RealtyCalendar** → раздел **Webhooks** → создайте новый
   webhook на этот URL и активируйте события:
   `create_booking`, `update_booking`, `cancel_booking`, `delete_booking`.
6. Сохраните настройки в RealtyCalendar.

### Привязка квартир
В разделе **Инвентарь** у каждой квартиры есть поле **«ID объекта в RealtyCalendar»**
(`realtyCalendarUnitId`). Заполните его — без этого ID бронь от RC не сможет привязаться
к конкретной квартире и будет пропущена (запись об этом появится в журнале интеграции).

ID объекта (`unit_id`) можно посмотреть в самом RealtyCalendar в карточке квартиры или
через их API.

---

## Бизнес-логика входящих броней (для справки)

- `amount` (валовый оборот) = `booking.amount`
- **`netAmount`** (чистая прибыль, она же то, «сколько реально получили») = `booking.prepayment`
- **Дата записи финансовой операции** = `booking.created_at` (день создания брони)
- **Залог не учитывается**
- `cancel_booking` / `delete_booking` → запись удаляется из финансов
- `update_booking` → запись обновляется по `booking_id` (внешний ID брони из RC)
- Если у квартиры пустой `realtyCalendarUnitId` → бронь пропускается, в журнал пишется ошибка

В финансовой ленте теперь видны **две суммы**: чистая (крупно) и валовый оборот рядом
помельче. То же — в сводке месяца и в разбивке по квартирам.

---

## Поиск проблем

| Симптом | Где смотреть |
|---|---|
| Webhook возвращает 401 | Не указан `--no-verify-jwt` при деплое функции — передеплойте |
| Webhook возвращает 200, но броней нет | Откройте `rc_webhook_log` — там будет колонка `error_text` с причиной (`agency_not_registered`, `apartment_not_found`, и т. д.) |
| В UI статус «Не подключено», хотя я нажал «Подключить» | Проверьте, что вы залогинены; проверьте `rc_integrations` в Supabase Studio (там должна быть строка с вашим `user_id`) |
| Брони приходят, но не попадают в финучёт | Проверьте, что у квартиры заполнен `realtyCalendarUnitId` |
| После деплоя UI выглядит как раньше | Жёсткое обновление: `Ctrl + Shift + R` |

Логи Edge Function: Supabase Studio → **Edge Functions** → **realtycalendar-webhook** → **Logs**.
Логи webhook-запросов в SQL: `SELECT * FROM rc_webhook_log ORDER BY received_at DESC LIMIT 50;`.
