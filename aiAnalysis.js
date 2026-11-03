/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// ИИ-анализ финучёта. Цифры считает сервер (Edge Function owner-report) по финучёту
// и броням RealtyCalendar, нейросеть Perplexity даёт выводы и советы. Ключ ИИ хранится
// только на сервере; персональные данные гостей в модель не передаются.
// =============================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { supabase } from './supabase-client.js';
import { openModal, closeModal } from './render.js';

const FN = `${SUPABASE_URL}/functions/v1/owner-report`;
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const byId = (id) => document.getElementById(id);
let wired = false;
let busy = false;
// Последний разбор и переписка — передаются модели как контекст уточняющих вопросов.
let lastText = '';

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

async function callAi(payload) {
  const { data: s } = await supabase.auth.getSession();
  const token = s?.session?.access_token;
  if (!token) throw new Error('Нужно войти в аккаунт');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const resp = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ action: 'ai_analysis', ...payload }),
      signal: ctrl.signal,
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json?.ok) throw new Error(json?.error || `Ошибка (${resp.status})`);
    return json;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Нейросеть не ответила вовремя, попробуйте ещё раз');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function setMsg(text) { const el = byId('aiAnalysisMsg'); if (el) el.textContent = text || ''; }
function setBusy(on) {
  busy = on;
  ['aiAnalysisRun', 'aiAnalysisAskBtn', 'aiAnalysisMonth'].forEach((id) => { const el = byId(id); if (el) el.disabled = on; });
}

async function runAnalysis() {
  if (busy) return;
  const month = byId('aiAnalysisMonth')?.value || moscowYm();
  const box = byId('aiAnalysisResult');
  setBusy(true);
  setMsg('Готовлю разбор, это занимает до минуты…');
  try {
    const res = await callAi({ month });
    lastText = res.text || '';
    if (box) { box.textContent = lastText; box.hidden = false; }
    byId('aiAnalysisAsk').hidden = false;
    setMsg('');
  } catch (e) {
    setMsg('Не получилось: ' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

async function askQuestion() {
  if (busy) return;
  const input = byId('aiAnalysisQuestion');
  const question = String(input?.value || '').trim();
  if (!question) { setMsg('Напишите вопрос'); return; }
  const month = byId('aiAnalysisMonth')?.value || moscowYm();
  const box = byId('aiAnalysisResult');
  setBusy(true);
  setMsg('Думаю над ответом…');
  try {
    const res = await callAi({ month, question, previous: lastText.slice(-4000) });
    const add = `\n\n— Вопрос: ${question}\n\n${res.text || ''}`;
    lastText += add;
    if (box) { box.textContent = lastText; box.hidden = false; }
    if (input) input.value = '';
    setMsg('');
  } catch (e) {
    setMsg('Не получилось: ' + (e?.message || e));
  } finally {
    setBusy(false);
  }
}

function wire() {
  if (wired) return;
  wired = true;
  byId('closeAiAnalysis')?.addEventListener('click', () => closeModal('aiAnalysisModal'));
  byId('aiAnalysisModal')?.addEventListener('click', (e) => { if (e.target?.id === 'aiAnalysisModal') closeModal('aiAnalysisModal'); });
  byId('aiAnalysisRun')?.addEventListener('click', runAnalysis);
  byId('aiAnalysisAskBtn')?.addEventListener('click', askQuestion);
  // Смена месяца — старый разбор больше не относится к выбранному месяцу.
  byId('aiAnalysisMonth')?.addEventListener('change', () => {
    lastText = '';
    const box = byId('aiAnalysisResult');
    if (box) { box.textContent = ''; box.hidden = true; }
    byId('aiAnalysisAsk').hidden = true;
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
  setMsg('');
  openModal('aiAnalysisModal');
}
