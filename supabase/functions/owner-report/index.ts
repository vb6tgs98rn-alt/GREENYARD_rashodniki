/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Supabase Edge Function: owner-report (v1)
// =============================================================================
// PDF-отчёт по квартире за цикл оплаты + отправка в отдельный Telegram-бот.
//
// Три входа (verify_jwt = false, проверка — внутри):
//  1) Telegram webhook (заголовок X-Telegram-Bot-Api-Secret-Token):
//     /start <код> — привязать чат, /stop — выключить отправку.
//  2) pg_cron (заголовок x-cron-secret): ежедневно в 09:00 МСК — отчёты по всем
//     квартирам, у которых сегодня день выплаты, за закончившийся цикл.
//     Повторная отправка за тот же цикл исключена журналом owner_report_log.
//  3) Приложение (Authorization: Bearer <JWT пользователя>):
//     status | link | toggle | pdf {apartmentId, from, to} | send {apartmentId, from, to}.
//
// Секреты — только в Vault (avito_get_secret / avito_set_secret):
// owner_report_bot_token, owner_report_webhook_secret, owner_report_cron_secret,
// owner_report_admin_user (владелец — задаётся миграцией; только он может менять токен).
// Токен вводится в приложении (action=setup_bot) и сразу уходит в Vault.
// =============================================================================

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";
import { PDFDocument, rgb } from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";
import {
  computeReport,
  renderReportPdf,
  reportFileName,
  cycleEndingBefore,
  isPaymentDay,
} from "../_shared/owner_report.ts";
import {
  computeCancelReport,
  renderCancelReportPdf,
  cancelReportFileName,
  previousMonth,
} from "../_shared/cancel_report.ts";
import {
  buildAnalyticsData,
  askAi,
  plainText,
  splitForTelegram,
  shiftMonth,
  AI_ANALYSIS_INSTRUCTIONS,
  AI_FOLLOWUP_INSTRUCTIONS,
  type AiBooking,
} from "../_shared/ai_analysis.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-cron-secret",
  "Access-Control-Expose-Headers": "content-disposition, x-file-name",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

// --- Секреты (кэш на время жизни инстанса) ---
const secretCache = new Map<string, string>();
async function getSecret(name: string): Promise<string> {
  if (secretCache.has(name)) return secretCache.get(name)!;
  const { data } = await admin.rpc("avito_get_secret", { p_name: name });
  const v = String(data || "").trim();
  if (v) secretCache.set(name, v);
  return v;
}

async function setSecret(name: string, value: string): Promise<void> {
  const { error } = await admin.rpc("avito_set_secret", { p_name: name, p_secret: value });
  if (error) throw new Error(`Vault: ${error.message}`);
  secretCache.set(name, value);
}

// --- Шрифт DejaVu Sans (кириллица и знак ₽) ---
const FONT_URLS = [
  "https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf",
  "https://unpkg.com/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf",
];
let fontCache: Uint8Array | null = null;
async function loadFont(): Promise<Uint8Array> {
  if (fontCache) return fontCache;
  let lastErr = "";
  for (const url of FONT_URLS) {
    try {
      const r = await fetch(url);
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      fontCache = new Uint8Array(await r.arrayBuffer());
      return fontCache;
    } catch (e) {
      lastErr = String((e as Error)?.message || e);
    }
  }
  throw new Error(`Не удалось загрузить шрифт: ${lastErr}`);
}

// --- Telegram ---
async function tg(method: string, payload: Record<string, unknown>): Promise<any> {
  const token = await getSecret("owner_report_bot_token");
  if (!token) throw new Error("Токен бота отчётов не задан");
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await r.json().catch(() => ({}));
}

async function tgSendDocument(chatId: number, bytes: Uint8Array, fileName: string, caption: string): Promise<void> {
  const token = await getSecret("owner_report_bot_token");
  if (!token) throw new Error("Токен бота отчётов не задан");
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("document", new Blob([bytes], { type: "application/pdf" }), fileName);
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) throw new Error(`Telegram: ${j?.description || r.status}`);
}

let botUsernameCache = "";
async function botUsername(): Promise<string> {
  if (botUsernameCache) return botUsernameCache;
  try {
    const j = await tg("getMe", {});
    botUsernameCache = j?.result?.username || "";
  } catch { /* токена ещё нет */ }
  return botUsernameCache;
}

// --- Дата по Москве (UTC+3, без перехода на летнее время) ---
function moscowToday(): string {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function isIso(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// --- Данные пользователя ---
async function loadUserData(userId: string, from: string): Promise<{ state: any; bookings: any[] }> {
  const { data: st, error: e1 } = await admin
    .from("app_state").select("state").eq("user_id", userId).maybeSingle();
  if (e1) throw new Error(`app_state: ${e1.message}`);
  const { data: bk, error: e2 } = await admin
    .from("rc_bookings")
    .select("booking_id, realty_id, begin_date, end_date, amount, status, raw_payload, platform_tax")
    .eq("user_id", userId)
    .not("status", "in", "(canceled,deleted)")
    .gte("end_date", from)
    .limit(5000);
  if (e2) throw new Error(`rc_bookings: ${e2.message}`);
  return { state: st?.state || {}, bookings: bk || [] };
}

async function buildReport(userId: string, apartmentId: string, from: string, to: string, preloaded?: { state: any; bookings: any[] }) {
  const { state, bookings } = preloaded || await loadUserData(userId, from);
  const apt = (state.apartments || []).find((a: any) => a.id === apartmentId);
  if (!apt) throw new Error("Квартира не найдена");
  const data = computeReport(state, bookings, apt, from, to);
  const bytes = await renderReportPdf({ PDFDocument, rgb, fontkit }, data, await loadFont());
  return { data, bytes, fileName: reportFileName(data) };
}

/** Журнальный ключ отчёта по отменам (вместо id квартиры в owner_report_log). */
const CANCEL_LOG_KEY = "__cancellations__";

/**
 * PDF «Отменённые брони» за прошлый месяц: отменённые и удалённые брони
 * с заездом в этом месяце, кроме отмеченных «Игнорировать».
 */
async function buildCancelReport(userId: string, todayIso: string) {
  const pm = previousMonth(todayIso);
  const { data: st, error: e1 } = await admin
    .from("app_state").select("apartments:state->apartments").eq("user_id", userId).maybeSingle();
  if (e1) throw new Error(`app_state: ${e1.message}`);
  const { data: bk, error: e2 } = await admin
    .from("rc_bookings")
    .select("booking_id, realty_id, apartment_title, source, begin_date, end_date, amount, platform_tax, raw_payload, cancellation_reason")
    .eq("user_id", userId)
    .in("status", ["canceled", "deleted"])
    .eq("cancel_ignored", false)
    .gte("begin_date", pm.from)
    .lte("begin_date", pm.to)
    .limit(2000);
  if (e2) throw new Error(`rc_bookings: ${e2.message}`);
  const apts = Array.isArray(st?.apartments) ? st.apartments : [];
  const data = computeCancelReport(apts, bk || [], pm.from, pm.to);
  const bytes = await renderCancelReportPdf({ PDFDocument, rgb, fontkit }, data, await loadFont());
  return { data, bytes, fileName: cancelReportFileName(data), from: pm.from, to: pm.to };
}

function captionOf(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

// =============================================================================
// ИИ-анализ финучёта (Perplexity Agent API, ключ — секрет PERPLEXITY_API_KEY)
// =============================================================================
const PPLX_API_KEY = (Deno.env.get("PERPLEXITY_API_KEY") || "").trim();
const AI_WEEKLY_LOG_KEY = "__ai_weekly__";
const AI_MONTHLY_LOG_KEY = "__ai_monthly__";
const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Сводка для модели: главный месяц и два предыдущих. */
async function loadAiData(userId: string, mainMonth: string, today: string) {
  const months = [shiftMonth(mainMonth, -2), shiftMonth(mainMonth, -1), mainMonth];
  // Брони берём за 6 месяцев (нужны для расхода закупок на один выезд),
  // но не позже начала самого раннего из анализируемых месяцев.
  const sixMonthsAgo = new Date(Date.parse(today + "T00:00:00Z") - 190 * 86400000).toISOString().slice(0, 10);
  const bookingsFrom = sixMonthsAgo < `${months[0]}-01` ? sixMonthsAgo : `${months[0]}-01`;
  const { data: st, error: e1 } = await admin
    .from("app_state").select("state").eq("user_id", userId).maybeSingle();
  if (e1) throw new Error(`app_state: ${e1.message}`);
  const { data: bk, error: e2 } = await admin
    .from("rc_bookings")
    .select("booking_id, realty_id, source, status, begin_date, end_date, amount, platform_tax, raw_tax:raw_payload->data->booking->>platform_tax")
    .eq("user_id", userId)
    .gte("end_date", bookingsFrom)
    .limit(5000);
  if (e2) throw new Error(`rc_bookings: ${e2.message}`);
  return buildAnalyticsData(st?.state || {}, (bk || []) as AiBooking[], months, today);
}

// Ограничение частоты запросов из приложения: не больше 20 в час на пользователя.
const aiHits = new Map<string, number[]>();
function aiRateOk(userId: string): boolean {
  const now = Date.now();
  const list = (aiHits.get(userId) || []).filter((t) => now - t < 3600000);
  if (list.length >= 20) { aiHits.set(userId, list); return false; }
  list.push(now);
  aiHits.set(userId, list);
  return true;
}

async function runAiAnalysis(userId: string, mainMonth: string, today: string, question = "", previous = "") {
  if (!PPLX_API_KEY) throw new Error("Не задан ключ PERPLEXITY_API_KEY");
  const data = await loadAiData(userId, mainMonth, today);
  const payload = JSON.stringify(data);
  const res = question
    ? await askAi(PPLX_API_KEY, AI_FOLLOWUP_INSTRUCTIONS,
      `Данные (JSON):\n${payload}\n\nПрошлый разбор:\n${previous.slice(0, 4000)}\n\nВопрос владельца: ${question.slice(0, 1000)}`, 1200)
    : await askAi(PPLX_API_KEY, AI_ANALYSIS_INSTRUCTIONS,
      `Главный месяц: ${mainMonth} (${monthName(mainMonth)}). Сегодня ${today}.\nДанные (JSON):\n${payload}`);
  console.log(`[owner-report] ai ok model=${res.model} cost_usd=${res.costUsd ?? "?"} q=${question ? 1 : 0}`);
  return { text: plainText(res.text), model: res.model, costUsd: res.costUsd, issues: data.accounting_issues.length };
}

/** Плановый ИИ-разбор в Telegram: 1-го числа — за прошлый месяц, по понедельникам — текущий месяц. */
async function sendAiDigest(cfg: { user_id: string; telegram_chat_id: number | string }, today: string, dry: boolean): Promise<any> {
  const isFirst = today.endsWith("-01");
  const isMonday = new Date(today + "T00:00:00Z").getUTCDay() === 1;
  if (!isFirst && !isMonday) return null;
  const key = isFirst ? AI_MONTHLY_LOG_KEY : AI_WEEKLY_LOG_KEY;
  const mainMonth = isFirst ? shiftMonth(today.slice(0, 7), -1) : today.slice(0, 7);
  const periodFrom = isFirst ? `${mainMonth}-01` : today;
  const { data: done } = await admin.from("owner_report_log")
    .select("sent_at").eq("user_id", cfg.user_id).eq("apartment_id", key).eq("period_from", periodFrom).maybeSingle();
  if (done) return { report: key, skipped: "уже отправлен" };
  const res = await runAiAnalysis(cfg.user_id, mainMonth, today);
  const title = isFirst ? `ИИ-разбор за ${monthName(mainMonth)}` : `ИИ-разбор: ${monthName(mainMonth)} на ${today.split("-").reverse().join(".")}`;
  if (!dry) {
    const parts = splitForTelegram(`${title}\n\n${res.text}`);
    for (const p of parts) {
      const j = await tg("sendMessage", { chat_id: Number(cfg.telegram_chat_id), text: p, disable_web_page_preview: true });
      if (!j?.ok) throw new Error(`Telegram: ${j?.description || "ошибка"}`);
    }
    await admin.from("owner_report_log").insert({
      user_id: cfg.user_id, apartment_id: key, period_from: periodFrom, period_to: today, file_name: title,
    });
  }
  return { report: key, month: mainMonth, sent: !dry, model: res.model, cost_usd: res.costUsd, chars: res.text.length, ...(dry ? { text: res.text } : {}) };
}

// =============================================================================
// 1) Telegram webhook
// =============================================================================
async function handleTelegram(req: Request): Promise<Response> {
  let update: any = {};
  try { update = await req.json(); } catch { /* пусто */ }
  const msg = update.message || update.edited_message;
  const chatId: number | undefined = msg?.chat?.id;
  const text: string = String(msg?.text || "").trim();
  if (!chatId || !text) return json({ ok: true });

  const reply = (t: string) => tg("sendMessage", { chat_id: chatId, text: t, parse_mode: "HTML" });

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1] || "";
    if (!code) {
      await reply("Это бот финансовых отчётов Green Yard.\n\nЧтобы подключить, откройте в приложении меню → «Отчёты в Telegram» и нажмите «Привязать Telegram».");
      return json({ ok: true });
    }
    const { data: cfg } = await admin.from("owner_report_config").select("user_id").eq("link_code", code).maybeSingle();
    if (!cfg) {
      await reply("Код не найден или устарел. Получите новый в приложении: меню → «Отчёты в Telegram».");
      return json({ ok: true });
    }
    await admin.from("owner_report_config")
      .update({ telegram_chat_id: chatId, link_code: null, enabled: true, updated_at: new Date().toISOString() })
      .eq("user_id", cfg.user_id);
    await reply("Готово. В день выплаты собственнику я буду присылать сюда PDF-отчёт по квартире за закончившийся цикл.");
    return json({ ok: true });
  }

  if (text.startsWith("/stop")) {
    const { data: cfg } = await admin.from("owner_report_config").select("user_id").eq("telegram_chat_id", chatId).maybeSingle();
    if (cfg) {
      await admin.from("owner_report_config").update({ enabled: false, updated_at: new Date().toISOString() }).eq("user_id", cfg.user_id);
      await reply("Отправка отчётов выключена. Включить снова можно в приложении.");
    } else {
      await reply("Этот чат не привязан.");
    }
    return json({ ok: true });
  }

  await reply("Я присылаю PDF-отчёты по квартирам в день выплаты. Команды: /start — подключить, /stop — выключить.");
  return json({ ok: true });
}

// =============================================================================
// 2) Ежедневный запуск (pg_cron)
// =============================================================================
async function handleCron(body: any): Promise<Response> {
  const today = isIso(body?.date) ? body.date : moscowToday();
  const dry = body?.dry === true;
  const onlyUser = typeof body?.userId === "string" ? body.userId : "";
  // Ручной предпросмотр: только PDF по отменам, без записи в журнал
  // (плановая отправка 1-го числа после этого не пропускается).
  const onlyCancel = body?.only === "cancellations";
  // Ручной запуск только ИИ-разбора (для проверки): {only:"ai", date:"ГГГГ-ММ-ДД", dry:true}.
  const onlyAi = body?.only === "ai";
  const preview = body?.preview === true;
  // ИИ-разборы идут в фоне после ответа: модель отвечает дольше, чем ждёт pg_cron.
  const aiJobs: Promise<unknown>[] = [];

  let q = admin.from("owner_report_config").select("user_id, telegram_chat_id").eq("enabled", true).not("telegram_chat_id", "is", null);
  if (onlyUser) q = q.eq("user_id", onlyUser);
  const { data: cfgs, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);

  const results: any[] = [];
  for (const cfg of cfgs || []) {
    try {
      // Брони берём с запасом: циклы длятся не больше 31 дня.
      const since = new Date(Date.parse(today + "T00:00:00Z") - 40 * 86400000).toISOString().slice(0, 10);
      const pre = await loadUserData(cfg.user_id, since);
      const apts = (pre.state.apartments || []).filter((a: any) => {
        if (onlyCancel || onlyAi) return false;
        if (a.archived) return false;
        const pd = Math.trunc(Number(a.paymentDay || 0));
        return pd >= 1 && pd <= 31 && isPaymentDay(today, pd);
      });
      for (const apt of apts) {
        const { from, to } = cycleEndingBefore(today, Math.trunc(Number(apt.paymentDay)));
        const { data: done } = await admin.from("owner_report_log")
          .select("sent_at").eq("user_id", cfg.user_id).eq("apartment_id", apt.id).eq("period_from", from).maybeSingle();
        if (done) { results.push({ apt: apt.name, from, to, skipped: "уже отправлен" }); continue; }
        const rep = await buildReport(cfg.user_id, apt.id, from, to, pre);
        if (!dry) {
          await tgSendDocument(Number(cfg.telegram_chat_id), rep.bytes, rep.fileName, captionOf(rep.fileName));
          await admin.from("owner_report_log").insert({
            user_id: cfg.user_id, apartment_id: apt.id, period_from: from, period_to: to, file_name: rep.fileName,
          });
        }
        results.push({ apt: apt.name, from, to, sent: !dry, bytes: rep.bytes.length });
      }

      // ИИ-разбор: 1-го числа — за прошлый месяц, по понедельникам — текущий месяц.
      if (!onlyCancel) {
        const job = sendAiDigest(cfg, today, dry)
          .then((r) => { if (r) console.log("[owner-report] ai digest", JSON.stringify(r)); return r; })
          .catch((e) => { console.error("[owner-report] ai digest error:", e); return { report: "ai", error: String((e as Error)?.message || e) }; });
        aiJobs.push(job);
      }

      // Первое число месяца — отчёт по отменам за прошлый месяц (один раз, по журналу).
      if (!onlyAi && (today.endsWith("-01") || onlyCancel)) {
        try {
          const pm = previousMonth(today);
          const { data: doneC } = preview ? { data: null } : await admin.from("owner_report_log")
            .select("sent_at").eq("user_id", cfg.user_id).eq("apartment_id", CANCEL_LOG_KEY).eq("period_from", pm.from).maybeSingle();
          if (doneC) {
            results.push({ report: "cancellations", from: pm.from, skipped: "уже отправлен" });
          } else {
            const rep = await buildCancelReport(cfg.user_id, today);
            if (!dry) {
              await tgSendDocument(Number(cfg.telegram_chat_id), rep.bytes, rep.fileName, captionOf(rep.fileName));
              if (!preview) await admin.from("owner_report_log").insert({
                user_id: cfg.user_id, apartment_id: CANCEL_LOG_KEY, period_from: rep.from, period_to: rep.to, file_name: rep.fileName,
              });
            }
            results.push({ report: "cancellations", from: rep.from, to: rep.to, count: rep.data.count, lost: rep.data.lost, sent: !dry, bytes: rep.bytes.length });
          }
        } catch (e) {
          results.push({ report: "cancellations", error: String((e as Error)?.message || e) });
        }
      }
    } catch (e) {
      results.push({ user: cfg.user_id, error: String((e as Error)?.message || e) });
    }
  }
  // Ручная проверка ИИ — ждём результат и возвращаем его в ответе.
  if (onlyAi) {
    const ai = await Promise.all(aiJobs);
    return json({ ok: true, date: today, results, ai });
  }
  // Плановый запуск — ИИ-разбор досылается в фоне, cron получает ответ сразу.
  if (aiJobs.length) {
    const all = Promise.all(aiJobs);
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(all); else await all;
  }
  return json({ ok: true, date: today, results, ai_scheduled: aiJobs.length });
}

// =============================================================================
// 3) Запросы приложения
// =============================================================================
async function handleApp(req: Request, body: any): Promise<Response> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "Нужно войти в аккаунт" }, 401);
  const { data: uData, error: uErr } = await admin.auth.getUser(jwt);
  const user = uData?.user;
  if (uErr || !user) return json({ ok: false, error: "Сессия истекла, войдите заново" }, 401);

  const action = String(body?.action || "");

  if (action === "status") {
    const { data: cfg } = await admin.from("owner_report_config")
      .select("telegram_chat_id, link_code, enabled").eq("user_id", user.id).maybeSingle();
    const adminUser = await getSecret("owner_report_admin_user");
    const username = await botUsername();
    return json({
      ok: true,
      bot_username: username,
      bot_configured: !!username,
      can_setup_bot: !!adminUser && adminUser === user.id,
      config: cfg ? { linked: !!cfg.telegram_chat_id, enabled: !!cfg.enabled, link_code: cfg.link_code || null } : null,
    });
  }

  // Настройка бота: проверяем токен, сохраняем в Vault, ставим вебхук.
  if (action === "setup_bot") {
    const adminUser = await getSecret("owner_report_admin_user");
    if (!adminUser || adminUser !== user.id) return json({ ok: false, error: "Настраивать бота может только владелец" }, 403);
    const token = String(body?.token || "").replace(/\s/g, "");
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) return json({ ok: false, error: "Непохоже на токен бота из @BotFather" }, 400);
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).catch(() => ({}));
    if (!me?.ok || !me?.result?.username) return json({ ok: false, error: "Telegram не принял токен" }, 400);
    let whSecret = await getSecret("owner_report_webhook_secret");
    if (!whSecret) {
      whSecret = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await setSecret("owner_report_webhook_secret", whSecret);
    }
    const wh = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${SUPABASE_URL}/functions/v1/owner-report`,
        secret_token: whSecret,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!wh?.ok) return json({ ok: false, error: `Не удалось подключить вебхук: ${wh?.description || "ошибка"}` }, 502);
    await setSecret("owner_report_bot_token", token);
    botUsernameCache = me.result.username;
    return json({ ok: true, bot_username: botUsernameCache });
  }

  if (action === "link") {
    const code = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const { error } = await admin.from("owner_report_config").upsert(
      { user_id: user.id, link_code: code, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, link_code: code, bot_username: await botUsername() });
  }

  if (action === "toggle") {
    const { error } = await admin.from("owner_report_config")
      .update({ enabled: !!body?.enabled, updated_at: new Date().toISOString() }).eq("user_id", user.id);
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true });
  }

  // ИИ-разбор финучёта: {month: 'ГГГГ-ММ', question?, previous?}.
  if (action === "ai_analysis") {
    const today = moscowToday();
    const month = /^\d{4}-\d{2}$/.test(String(body?.month || "")) ? String(body.month) : today.slice(0, 7);
    if (month > today.slice(0, 7)) return json({ ok: false, error: "Месяц ещё не начался" }, 400);
    const question = String(body?.question || "").trim().slice(0, 1000);
    const previous = String(body?.previous || "").slice(0, 4000);
    // Повторное нажатие, пока прошлый такой же разбор ещё готовится, — отдаём тот же.
    const since = new Date(Date.now() - 4 * 60000).toISOString();
    let dupQ = admin.from("ai_analysis_results").select("id")
      .eq("user_id", user.id).eq("month", month).eq("status", "pending").gte("created_at", since);
    dupQ = question ? dupQ.eq("question", question) : dupQ.is("question", null);
    const { data: dup } = await dupQ.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (dup?.id) return json({ ok: true, month, jobId: dup.id });

    if (!aiRateOk(user.id)) return json({ ok: false, error: "Слишком много запросов, попробуйте через час" }, 429);
    // Чистим разборы старше 30 дней.
    await admin.from("ai_analysis_results").delete()
      .eq("user_id", user.id).lt("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    const { data: job, error: jErr } = await admin.from("ai_analysis_results")
      .insert({ user_id: user.id, month, question: question || null, status: "pending" })
      .select("id").single();
    if (jErr || !job) return json({ ok: false, error: `Не удалось создать разбор: ${jErr?.message || "ошибка"}` }, 500);

    // Разбор готовится в фоне и записывается в таблицу: приложение заберёт его,
    // даже если телефон оборвал соединение (свернули приложение).
    const work = runAiAnalysis(user.id, month, today, question, previous)
      .then((res) => admin.from("ai_analysis_results").update({
        status: "done", text: res.text, model: res.model, cost_usd: res.costUsd, finished_at: new Date().toISOString(),
      }).eq("id", job.id))
      .catch((e) => admin.from("ai_analysis_results").update({
        status: "error", error: String((e as Error)?.message || e).slice(0, 500), finished_at: new Date().toISOString(),
      }).eq("id", job.id))
      .then((r: any) => { if (r?.error) console.error("[owner-report] ai job save error:", r.error.message); });
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(work); else await work;
    return json({ ok: true, month, jobId: job.id });
  }

  if (action === "pdf" || action === "send") {
    const apartmentId = String(body?.apartmentId || "");
    const from = body?.from, to = body?.to;
    if (!apartmentId || !isIso(from) || !isIso(to) || from > to) {
      return json({ ok: false, error: "Неверные параметры отчёта" }, 400);
    }
    const rep = await buildReport(user.id, apartmentId, from, to);
    if (action === "pdf") {
      return new Response(rep.bytes, {
        status: 200,
        headers: {
          ...cors,
          "content-type": "application/pdf",
          "x-file-name": encodeURIComponent(rep.fileName),
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(rep.fileName)}`,
        },
      });
    }
    const { data: cfg } = await admin.from("owner_report_config")
      .select("telegram_chat_id").eq("user_id", user.id).maybeSingle();
    if (!cfg?.telegram_chat_id) return json({ ok: false, error: "Telegram не привязан" }, 400);
    await tgSendDocument(Number(cfg.telegram_chat_id), rep.bytes, rep.fileName, captionOf(rep.fileName));
    return json({ ok: true, file_name: rep.fileName });
  }

  return json({ ok: false, error: "Неизвестное действие" }, 400);
}

// =============================================================================
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Метод не поддерживается" }, 405);

  try {
    // Telegram webhook
    const tgSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (tgSecret !== null) {
      const want = await getSecret("owner_report_webhook_secret");
      if (!want || tgSecret !== want) return json({ ok: false }, 403);
      return await handleTelegram(req);
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* пусто */ }

    // Cron
    const cronSecret = req.headers.get("x-cron-secret");
    if (cronSecret !== null) {
      const want = await getSecret("owner_report_cron_secret");
      if (!want || cronSecret !== want) return json({ ok: false }, 403);
      return await handleCron(body);
    }

    // Приложение
    return await handleApp(req, body);
  } catch (e) {
    console.error("[owner-report]", e);
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
