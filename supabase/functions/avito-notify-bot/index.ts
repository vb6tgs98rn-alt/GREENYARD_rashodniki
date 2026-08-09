/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Supabase Edge Function: avito-notify-bot (v1)
// =============================================================================
// Webhook отдельного Telegram-бота уведомлений Авито.
// /start <код> — привязывает чат к аккаунту (код выдаётся в веб-приложении).
// /stop — отключает уведомления. Защита: X-Telegram-Bot-Api-Secret-Token.
// =============================================================================

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getSecret(name: string): Promise<string> {
  const { data } = await admin.rpc("avito_get_secret", { p_name: name });
  return (data as string) || "";
}

async function reply(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
}

serve(async (req) => {
  // Проверка секрета вебхука.
  const wantSecret = await getSecret("avito_notify_webhook_secret");
  const gotSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!wantSecret || gotSecret !== wantSecret) {
    return new Response(JSON.stringify({ ok: false }), { status: 403 });
  }

  const token = await getSecret("avito_notify_bot_token");
  let update: any = {};
  try { update = await req.json(); } catch { /* пусто */ }

  const msg = update.message || update.edited_message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = (msg?.text || "").trim();
  if (!chatId || !text) return new Response(JSON.stringify({ ok: true }));

  // /start <код>
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const code = parts[1] || "";
    if (!code) {
      await reply(token, chatId,
        "👋 Это бот уведомлений <b>Авито</b>.\n\nЧтобы подключить, откройте в приложении Green Yard раздел «Уведомления Авито» и нажмите «Привязать Telegram» — я начну присылать сюда уведомления о бронях, оплатах и сообщениях гостей.");
      return new Response(JSON.stringify({ ok: true }));
    }
    const { data: cfg } = await admin
      .from("avito_notify_config")
      .select("user_id")
      .eq("link_code", code)
      .maybeSingle();
    if (!cfg) {
      await reply(token, chatId, "⚠️ Код не найден или устарел. Откройте раздел «Уведомления Авито» в приложении и получите новый код.");
      return new Response(JSON.stringify({ ok: true }));
    }
    await admin.from("avito_notify_config")
      .update({ telegram_chat_id: chatId, enabled: true, updated_at: new Date().toISOString() })
      .eq("user_id", cfg.user_id);
    await reply(token, chatId,
      "✅ <b>Готово!</b> Уведомления Авито подключены к этому чату.\n\nБуду присылать: новые мгновенные брони, оплаты и сообщения гостей. Отключить — команда /stop.");
    return new Response(JSON.stringify({ ok: true }));
  }

  // /stop
  if (text.startsWith("/stop")) {
    const { data: cfg } = await admin
      .from("avito_notify_config")
      .select("user_id")
      .eq("telegram_chat_id", chatId)
      .maybeSingle();
    if (cfg) {
      await admin.from("avito_notify_config")
        .update({ enabled: false, updated_at: new Date().toISOString() })
        .eq("user_id", cfg.user_id);
      await reply(token, chatId, "⏸ Уведомления отключены. Включить снова можно в приложении Green Yard.");
    } else {
      await reply(token, chatId, "Этот чат не привязан. Подключите уведомления в приложении Green Yard.");
    }
    return new Response(JSON.stringify({ ok: true }));
  }

  // Прочее — короткая подсказка.
  await reply(token, chatId, "Я присылаю уведомления Авито. Команды: /start — подключить, /stop — отключить.");
  return new Response(JSON.stringify({ ok: true }));
});
