/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Supabase Edge Function: avito-notify-config (v1)
// =============================================================================
// Вызывается из веб-приложения (с JWT пользователя). Сохраняет почту и пароль
// приложения (пароль → в Vault), проверяет вход по IMAP, выдаёт код привязки
// Telegram, отдаёт статус, умеет отключать/удалять.
// =============================================================================

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { ImapClient } from "../_shared/avito_imap.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_USERNAME = "Avito_fast_message_bot";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

// Определяем IMAP-хост по домену почты.
function imapHostFor(email: string): string | null {
  const dom = (email.split("@")[1] || "").toLowerCase();
  if (!dom) return null;
  if (/(^|\.)(yandex\.|ya\.ru|yandex\.ru)/.test(dom) || dom === "ya.ru") return "imap.yandex.ru";
  if (dom.startsWith("yandex")) return "imap.yandex.ru";
  if (dom === "gmail.com" || dom === "googlemail.com") return "imap.gmail.com";
  if (["mail.ru", "bk.ru", "inbox.ru", "list.ru", "internet.ru", "mail.ua"].includes(dom)) return "imap.mail.ru";
  return null; // неизвестный домен — попросим указать хост вручную
}

function newLinkCode(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  // Аутентификация пользователя по JWT.
  const authz = req.headers.get("Authorization") || "";
  const jwt = authz.replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "нет авторизации" }, 401);
  const { data: uData, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !uData?.user) return json({ ok: false, error: "сессия недействительна" }, 401);
  const user = uData.user;

  let body: any = {};
  try { body = await req.json(); } catch { /* пусто */ }
  const action = body.action || "status";

  // ── Статус ────────────────────────────────────────────────────────────────
  if (action === "status") {
    const { data: cfg } = await admin
      .from("avito_notify_config")
      .select("email, imap_host, provider, enabled, telegram_chat_id, link_code, last_ok_at, last_error")
      .eq("user_id", user.id)
      .maybeSingle();
    return json({
      ok: true,
      bot_username: BOT_USERNAME,
      config: cfg
        ? {
          email: cfg.email,
          imap_host: cfg.imap_host,
          enabled: cfg.enabled,
          linked: cfg.telegram_chat_id != null,
          link_code: cfg.link_code,
          last_ok_at: cfg.last_ok_at,
          last_error: cfg.last_error,
        }
        : null,
    });
  }

  // ── Сохранение почты и пароля ───────────────────────────────────────────────
  if (action === "save") {
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    let host = String(body.imap_host || "").trim();
    const port = Number(body.imap_port) || 993;
    if (!email || !password) return json({ ok: false, error: "укажите почту и пароль приложения" }, 400);
    if (!host) {
      const guessed = imapHostFor(email);
      if (!guessed) return json({ ok: false, error: "не удалось определить IMAP-сервер по домену — укажите его вручную" }, 400);
      host = guessed;
    }

    // Проверяем вход по IMAP до сохранения.
    const client = new ImapClient();
    let uidNext = 0, uidValidity = 0;
    try {
      await client.connect(host, port);
      await client.login(email, password);
      const sel = await client.selectInbox();
      uidNext = sel.uidNext;
      uidValidity = sel.uidValidity;
    } catch (e) {
      return json({ ok: false, error: "Не удалось войти в почту: " + String(e).slice(0, 200) }, 400);
    } finally {
      await client.logout();
    }

    // Пароль → в Vault.
    const secretName = `avito_imap_${user.id}`;
    const { error: secErr } = await admin.rpc("avito_set_secret", { p_name: secretName, p_secret: password });
    if (secErr) return json({ ok: false, error: "не удалось сохранить пароль: " + secErr.message }, 500);

    // Существующий конфиг (сохраняем привязку Telegram и код).
    const { data: existing } = await admin
      .from("avito_notify_config")
      .select("link_code, telegram_chat_id")
      .eq("user_id", user.id)
      .maybeSingle();
    const link_code = existing?.link_code || newLinkCode();

    const { error: upErr } = await admin.from("avito_notify_config").upsert({
      user_id: user.id,
      email,
      imap_host: host,
      imap_port: port,
      provider: imapHostFor(email) ? host.replace("imap.", "").replace(".ru", "") : null,
      secret_name: secretName,
      link_code,
      enabled: true,
      last_uid: Math.max(0, uidNext - 1), // бэклог не шлём — только новые письма
      uidvalidity: uidValidity,
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (upErr) return json({ ok: false, error: upErr.message }, 500);

    return json({
      ok: true,
      linked: existing?.telegram_chat_id != null,
      link_code,
      bot_username: BOT_USERNAME,
      link_url: `https://t.me/${BOT_USERNAME}?start=${link_code}`,
    });
  }

  // ── Включить/выключить ──────────────────────────────────────────────────────
  if (action === "toggle") {
    const enabled = !!body.enabled;
    const { error } = await admin.from("avito_notify_config")
      .update({ enabled, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, enabled });
  }

  // ── Удалить (отключить и стереть привязку) ──────────────────────────────────
  if (action === "delete") {
    await admin.from("avito_notify_config").delete().eq("user_id", user.id);
    // Секрет пароля тоже затираем.
    await admin.rpc("avito_set_secret", { p_name: `avito_imap_${user.id}`, p_secret: "" });
    return json({ ok: true });
  }

  return json({ ok: false, error: "неизвестное действие" }, 400);
});
