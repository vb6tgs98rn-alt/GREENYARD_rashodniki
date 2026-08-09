/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Supabase Edge Function: avito-notify-poll (v1)
// =============================================================================
// Опрашивает почтовые ящики пользователей по IMAP, забирает ТОЛЬКО заголовки
// писем от avito.ru, классифицирует по теме и шлёт уведомление в Telegram.
// Персональные данные не читаются и не хранятся. Вызывается по pg_cron.
// Защита: заголовок x-cron-secret (секрет в Vault).
// =============================================================================

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import {
  classifyAvito,
  ImapClient,
  isFromAvito,
  notifyText,
} from "../_shared/avito_imap.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function getSecret(name: string): Promise<string> {
  const { data, error } = await admin.rpc("avito_get_secret", { p_name: name });
  if (error) throw new Error("Vault: " + error.message);
  return (data as string) || "";
}

async function sendTelegram(token: string, chatId: number, text: string): Promise<boolean> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  return resp.ok;
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

serve(async (req) => {
  const url = new URL(req.url);

  // Проверка секрета.
  let cronSecret = "";
  try { cronSecret = await getSecret("avito_notify_cron_secret"); } catch { /* ignore */ }
  const provided = req.headers.get("x-cron-secret") || url.searchParams.get("s") || "";
  if (!cronSecret || provided !== cronSecret) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  // Пробник связи: ?probe=imap.yandex.ru — проверяет TLS и приветствие сервера.
  const probe = url.searchParams.get("probe");
  if (probe) {
    try {
      const conn = await Deno.connectTls({ hostname: probe, port: 993 });
      const buf = new Uint8Array(512);
      const n = await conn.read(buf);
      conn.close();
      const greeting = new TextDecoder().decode(buf.subarray(0, n ?? 0));
      return json({ ok: true, probe, greeting: greeting.trim() });
    } catch (e) {
      return json({ ok: false, probe, error: String(e) }, 500);
    }
  }

  let botToken = "";
  try { botToken = await getSecret("avito_notify_bot_token"); } catch { /* ignore */ }
  if (!botToken) return json({ ok: false, error: "нет токена бота" }, 500);

  // Активные конфиги с привязанным Telegram.
  const { data: configs, error: cfgErr } = await admin
    .from("avito_notify_config")
    .select("*")
    .eq("enabled", true)
    .not("telegram_chat_id", "is", null);
  if (cfgErr) return json({ ok: false, error: cfgErr.message }, 500);

  const summary: any[] = [];

  for (const cfg of (configs || [])) {
    const client = new ImapClient();
    let sent = 0;
    try {
      const pass = await getSecret(cfg.secret_name);
      if (!pass) throw new Error("нет пароля в Vault");

      await client.connect(cfg.imap_host, cfg.imap_port || 993);
      await client.login(cfg.email, pass);
      const sel = await client.selectInbox();

      // Определяем стартовый UID: первый прогон и сброс UIDVALIDITY не шлют бэклог.
      let since = cfg.last_uid || 0;
      if (!cfg.uidvalidity || (sel.uidValidity && cfg.uidvalidity !== sel.uidValidity)) {
        since = Math.max(since, Math.max(0, sel.uidNext - 1));
      }

      const uids = (await client.searchAvito(since)).sort((a, b) => a - b);
      const headers = uids.length ? await client.fetchHeaders(uids) : [];
      headers.sort((a, b) => a.uid - b.uid);

      // Докручиваем last_uid только до успешно обработанных писем (без потерь).
      let committed = since;
      for (const h of headers) {
        if (!isFromAvito(h.from)) { committed = h.uid; continue; }
        const kind = classifyAvito(h.subject);
        const msgId = h.messageId || `uid:${cfg.user_id}:${h.uid}`;

        // Антидубликат: уже отправляли?
        const { data: seen } = await admin
          .from("avito_notify_log")
          .select("id")
          .eq("user_id", cfg.user_id)
          .eq("msg_id", msgId)
          .maybeSingle();
        if (seen) { committed = h.uid; continue; }

        const okSend = await sendTelegram(botToken, cfg.telegram_chat_id, notifyText(kind));
        if (!okSend) break; // не удалось отправить — оставим на следующий цикл

        await admin.from("avito_notify_log").insert({ user_id: cfg.user_id, msg_id: msgId, kind });
        sent++;
        committed = h.uid;
      }

      await admin.from("avito_notify_config").update({
        last_uid: committed,
        uidvalidity: sel.uidValidity,
        last_ok_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }).eq("user_id", cfg.user_id);

      summary.push({ user: cfg.user_id, checked: headers.length, sent });
    } catch (e) {
      await admin.from("avito_notify_config").update({
        last_error: String(e).slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("user_id", cfg.user_id);
      summary.push({ user: cfg.user_id, error: String(e).slice(0, 200) });
    } finally {
      await client.logout();
    }
  }

  return json({ ok: true, configs: (configs || []).length, summary });
});
