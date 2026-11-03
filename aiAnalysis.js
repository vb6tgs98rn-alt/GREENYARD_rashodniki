/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// ИИ-анализ финучёта. Цифры считает сервер (Edge Function owner-report) по финучёту
// и броням RealtyCalendar, нейросеть Perplexity даёт выводы и советы. Ключ ИИ хранится
// только на сервере; персональные данные гостей в модель не передаются.
//
// Разбор готовится на сервере в фоне и сохраняется в таблицу ai_analysis_results.
// Приложение лишь спрашивает, готов ли он, — поэтому ответ не теряется, если
// приложение свернули и телефон оборвал соединение. Таблица читается только
// в этом окне и на загрузку приложения не влияет.
// =============================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { supabase } from './supabase-client.js';
import { openModal, closeModal } from './render.js';

const FN = `${SUPABASE_URL}/functions/v1/owner-report`;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const POLL_MS = 3000;
// Дольше этого разбор считается зависшим.
const STALE_MS = 4 * 60000;

const byId = (id) => document.getElementById(id);
let wired = false;
let busy = false;
// Текст на экране (разбор + вопросы) — передаётся модели как контекст уточняющих вопросов.
let lastText = '';
// Разбор, который сейчас готовится: { id, month, question, startedAt }.
let pending = null;
let pollTimer = null;

// Сегодняшний месяц по Москве.
function moscowYm() {
  return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 7);
}
function shiftYm(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function ymLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
}
function selectedMonth() { return byId('aiAnalysisMonth')?.value || moscowYm(); }
function isOpen() { return byId('aiAnalysisModal')?.classList.contains('open'); }

// Запуск разбора на сервере — возвращает id задания.
async function startJob(payload) {
  const { data: s } = await supabase.auth.getSession();
  const token = s?.session?.access_token;
  if (!token) throw new Error('Нужно войти в аккаунт');
  const resp = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ action: 'ai_analysis', ...payload }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json?.ok || !json?.jobId) throw new Error(json?.error || `Ошибка (${resp.status})`);
  return json.jobId;
}

// Последнее задание по месяцу и вопросу за последние минуты (если ответ на запуск не дошёл).
async function findRecentJob(month, question) {
  let q = supabase.from('ai_analysis_results').select('id, created_at')
    .eq('month', month).gte('created_at', new Date(Date.now() - STALE_MS).toISOString());
  q = question ? q.eq('question', question) : q.is('question', null);
  const { data } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.id || null;
}

function setMsg(text) { const el = byId('aiAnalysisMsg'); if (el) el.textContent = text || ''; }
function setBusy(on) {
  busy = on;
  ['aiAnalysisRun', 'aiAnalysisAskBtn', 'aiAnalysisMonth'].forEach((id) => { const el = byId(id); if (el) el.disabled = on; });
}
function showText(text) {
  lastText = text || '';
  const box = byId('aiAnalysisResult');
  if (box) { box.textContent = lastText; box.hidden = !lastText; }
  const ask = byId('aiAnalysisAsk');
  if (ask) ask.hidden = !lastText;
}

// Последний разбор за месяц и вопросы после него — показываются сразу и бесплатно.
async function loadThread(month) {
  const { data: main } = await supabase.from('ai_analysis_results')
    .select('id, text, created_at')
    .eq('month', month).eq('status', 'done').is('question', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!main) return '';
  const { data: follow } = await supabase.from('ai_analysis_results')
    .select('question, text, created_at')
    .eq('month', month).eq('status', 'done').not('question', 'is', null).gt('created_at', main.created_at)
    .order('created_at', { ascending: true }).limit(20);
  const when = new Date(main.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  let text = `Разбор от ${when}\n\n${main.text || ''}`;
  for (const f of follow || []) text += `\n\n— Вопрос: ${f.question}\n\n${f.text || ''}`;
  return text;
}

async function refreshForMonth(month) {
  showText('');
  setMsg('');
  try {
    const text = await loadThread(month);
    if (selectedMonth() !== month) return;
    showText(text);
    // Разбор по этому месяцу ещё готовится (например, после перезагрузки страницы).
    if (!pending) {
      const { data: p } = await supabase.from('ai_analysis_results')
        .select('id, question, created_at')
        .eq('month', month).eq('status', 'pending').gte('created_at', new Date(Date.now() - STALE_MS).toISOString())
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (p && selectedMonth() === month) {
        pending = { id: p.id, month, question: p.question || '', startedAt: Date.parse(p.created_at) };
        setBusy(true);
        setMsg(p.question ? 'Думаю над ответом…' : 'Готовлю разбор, это занимает до минуты…');
        schedulePoll(0);
      }
    }
  } catch (e) {
    setMsg('Не удалось загрузить прошлый разбор: ' + (e?.message || e));
  }
}

function schedulePoll(delay = POLL_MS) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollOnce, delay);
}

async function pollOnce() {
  pollTimer = null;
  if (!pending) return;
  const job = pending;
  try {
    const { data, error } = await supabase.from('ai_analysis_results')
      .select('status, text, error').eq('id', job.id).maybeSingle();
    if (error) throw error;
    if (pending !== job) return;
    if (data?.status === 'done') {
      pending = null;
      setBusy(false);
      setMsg('');
      if (selectedMonth() === job.month) {
        if (job.question) {
          showText(`${lastText}\n\n— Вопрос: ${job.question}\n\n${data.text || ''}`);
          const input = byId('aiAnalysisQuestion');
          if (input) input.value = '';
        } else {
          showText(await loadThread(job.month));
        }
      }
      return;
    }
    if (data?.status === 'error') {
      pending = null;
      setBusy(false);
      setMsg('Не получилось: ' + (data.error || 'ошибка нейросети'));
      return;
    }
    if (Date.now() - job.startedAt > STALE_MS) {
      pending = null;
      setBusy(false);
      setMsg('Нейросеть не ответила вовремя, попробуйте ещё раз');
      return;
    }
  } catch (e) {
    // Сеть пропала (приложение свёрнуто) — просто спросим ещё раз позже.
    console.warn('[ai] poll:', e?.message || e);
  }
  if (pending === job && isOpen()) schedulePoll();
}

async function launch(question) {
  if (busy) return;
  const month = selectedMonth();
  setBusy(true);
  setMsg(question ? 'Думаю над ответом…' : 'Готовлю разбор, это занимает до минуты…');
  const startedAt = Date.now();
  let id = null;
  try {
    id = await startJob(question ? { month, question, previous: lastText.slice(-4000) } : { month });
  } catch (e) {
    // Запрос мог дойти до сервера, а ответ — потеряться. Ищем созданное задание.
    id = await findRecentJob(month, question).catch(() => null);
    if (!id) {
      setBusy(false);
      setMsg('Не получилось: ' + (e?.message || e));
      return;
    }
  }
  pending = { id, month, question: question || '', startedAt };
  schedulePoll();
}

function runAnalysis() { launch(''); }
function askQuestion() {
  const question = String(byId('aiAnalysisQuestion')?.value || '').trim();
  if (!question) { setMsg('Напишите вопрос'); return; }
  launch(question);
}

function wire() {
  if (wired) return;
  wired = true;
  byId('closeAiAnalysis')?.addEventListener('click', () => closeModal('aiAnalysisModal'));
  byId('aiAnalysisModal')?.addEventListener('click', (e) => { if (e.target?.id === 'aiAnalysisModal') closeModal('aiAnalysisModal'); });
  byId('aiAnalysisRun')?.addEventListener('click', runAnalysis);
  byId('aiAnalysisAskBtn')?.addEventListener('click', askQuestion);
  byId('aiAnalysisMonth')?.addEventListener('change', () => refreshForMonth(selectedMonth()));
  // Вернулись в приложение — сразу проверяем, готов ли разбор.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pending && isOpen()) schedulePoll(0);
  });
}

/** Открыть окно ИИ-анализа. */
export function openAiAnalysisModal() {
  wire();
  const sel = byId('aiAnalysisMonth');
  if (sel && !sel.options.length) {
    const cur = moscowYm();
    for (let i = 0; i < 6; i++) {
      const ym = shiftYm(cur, -i);
      const opt = document.createElement('option');
      opt.value = ym;
      opt.textContent = i === 0 ? `${ymLabel(ym)} (текущий)` : ymLabel(ym);
      sel.appendChild(opt);
    }
  }
  openModal('aiAnalysisModal');
  if (pending) {
    // Разбор ещё готовится — продолжаем ждать его.
    if (sel) sel.value = pending.month;
    setBusy(true);
    schedulePoll(0);
  } else {
    refreshForMonth(selectedMonth());
  }
}
