// Минимальный IMAP-клиент для уведомлений Авито.
// Читает ТОЛЬКО заголовки писем (From, Subject, Message-ID, Date) — тело не скачивается.
// Никаких персональных данных: классификация идёт по теме письма.

export interface MailHeaders {
  uid: number;
  from: string;
  subject: string;
  messageId: string;
  date: string;
}

export interface SelectInfo {
  uidValidity: number;
  uidNext: number;
}

// ─── RFC 2047: декодирование =?charset?B/Q?...?= в заголовках ────────────────
function decodeRfc2047(input: string): string {
  if (!input || input.indexOf("=?") === -1) return input;
  // Пробелы между соседними encoded-words по RFC 2047 удаляются (иначе слова рвутся).
  const glued = input.replace(/\?=\s+=\?/g, "?==?");
  return glued.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    try {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === "B") {
        const bin = atob(text.replace(/\s+/g, ""));
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else {
        // Quoted-printable в варианте Q: '_' → пробел, =XX → байт.
        const q = text.replace(/_/g, " ");
        const out: number[] = [];
        for (let i = 0; i < q.length; i++) {
          if (q[i] === "=" && i + 2 < q.length) {
            out.push(parseInt(q.substr(i + 1, 2), 16));
            i += 2;
          } else {
            out.push(q.charCodeAt(i));
          }
        }
        bytes = Uint8Array.from(out);
      }
      try {
        return new TextDecoder(String(charset).toLowerCase()).decode(bytes);
      } catch {
        return new TextDecoder("utf-8").decode(bytes);
      }
    } catch {
      return text;
    }
  });
}

// Разбор блока заголовков (с разворачиванием переносов).
function parseHeaderBlock(block: string): Record<string, string> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  const res: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (!(key in res)) res[key] = val;
  }
  return res;
}

// ─── Разбор MIME для поиска ключевых фраз в теле письма ─────────────────────────────
// Письма Авито — multipart (text/plain + text/html), каждая часть со своим
// Content-Transfer-Encoding. Раньше декодировался только верхний уровень и первые 8 КБ,
// поэтому фразы вроде «В чат вернулись ограничения» иногда не находились.

function decodeTransfer(raw: string, enc: string, charset: string): string {
  const cs = (charset || "utf-8").trim() || "utf-8";
  try {
    if (enc === "base64") {
      const bin = atob(raw.replace(/[^A-Za-z0-9+/=]/g, ""));
      return new TextDecoder(cs).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    if (enc === "quoted-printable") {
      const s = raw.replace(/=\r?\n/g, "");
      const bytes: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const hex = s.substr(i + 1, 2);
        if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          // Символы вне ASCII в QP не должны встречаться; на всякий случай кодируем в UTF-8.
          const code = s.charCodeAt(i);
          if (code < 128) bytes.push(code);
          else bytes.push(...new TextEncoder().encode(s[i]));
        }
      }
      return new TextDecoder(cs).decode(Uint8Array.from(bytes));
    }
  } catch { /* вернём как есть */ }
  return raw;
}

// HTML → простой текст с нормализацией пробелов и сущностей.
export function htmlToPlain(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&laquo;/gi, "«")
    .replace(/&raquo;/gi, "»")
    .replace(/&mdash;|&ndash;/gi, "—")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/[\u00a0\u202f\u2007]/g, " ")
    .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Рекурсивно достаём весь текст из MIME-сущности (заголовки + тело).
export function mimeToText(entity: string, depth = 0): string {
  if (depth > 6) return "";
  const sep = entity.search(/\r?\n\r?\n/);
  const headRaw = sep >= 0 ? entity.slice(0, sep) : "";
  const body = sep >= 0 ? entity.slice(sep).replace(/^\r?\n\r?\n/, "") : entity;
  const h = parseHeaderBlock(headRaw);
  const ctype = String(h["content-type"] || "text/plain").toLowerCase();
  const enc = String(h["content-transfer-encoding"] || "").toLowerCase().trim();
  if (ctype.startsWith("multipart/")) {
    const bm = String(h["content-type"] || "").match(/boundary\s*=\s*"?([^";]+)"?/i);
    if (!bm) return htmlToPlain(body);
    const boundary = "--" + bm[1].trim();
    const parts = body.split(boundary).slice(1).filter((p) => !p.startsWith("--"));
    return parts.map((p) => mimeToText(p.replace(/^\r?\n/, ""), depth + 1)).join(" ");
  }
  if (!ctype.startsWith("text/")) return ""; // картинки и вложения не нужны
  const cm = ctype.match(/charset\s*=\s*"?([^";]+)"?/);
  const decoded = decodeTransfer(body, enc, cm ? cm[1] : "utf-8");
  return htmlToPlain(decoded);
}

export class ImapClient {
  private conn: Deno.TlsConn | null = null;
  private buf = new Uint8Array(0);
  private tagN = 0;
  private td = new TextDecoder("utf-8");
  private enc = new TextEncoder();

  async connect(host: string, port = 993): Promise<void> {
    this.conn = await Deno.connectTls({ hostname: host, port });
    await this.readLine(); // приветствие сервера (* OK ...)
  }

  private async fill(): Promise<boolean> {
    if (!this.conn) throw new Error("нет соединения");
    const chunk = new Uint8Array(16384);
    const n = await this.conn.read(chunk);
    if (n === null) return false;
    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf, 0);
    merged.set(chunk.subarray(0, n), this.buf.length);
    this.buf = merged;
    return true;
  }

  private indexOfCRLF(): number {
    for (let i = 0; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 13 && this.buf[i + 1] === 10) return i;
    }
    return -1;
  }

  private async readLine(): Promise<string> {
    let idx = this.indexOfCRLF();
    while (idx === -1) {
      const ok = await this.fill();
      if (!ok) { // EOF: вернём остаток
        const rest = this.td.decode(this.buf);
        this.buf = new Uint8Array(0);
        return rest;
      }
      idx = this.indexOfCRLF();
    }
    const line = this.td.decode(this.buf.subarray(0, idx));
    this.buf = this.buf.subarray(idx + 2);
    return line;
  }

  private async readExact(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      const ok = await this.fill();
      if (!ok) break;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return new Uint8Array(out);
  }

  private async send(line: string): Promise<void> {
    if (!this.conn) throw new Error("нет соединения");
    await this.conn.write(this.enc.encode(line + "\r\n"));
  }

  // Выполнить команду; вернуть { ok, text, literals } с учётом литералов {n}.
  private async command(cmd: string): Promise<{ ok: boolean; text: string; literals: string[] }> {
    const tag = "a" + (++this.tagN);
    await this.send(tag + " " + cmd);
    const parts: string[] = [];
    const literals: string[] = [];
    while (true) {
      let line = await this.readLine();
      let m = line.match(/\{(\d+)\}$/);
      while (m) {
        const len = parseInt(m[1], 10);
        const litBytes = await this.readExact(len);
        literals.push(this.td.decode(litBytes));
        line = line.slice(0, m.index);
        const cont = await this.readLine();
        line += cont;
        m = line.match(/\{(\d+)\}$/);
      }
      parts.push(line);
      if (line.startsWith(tag + " ")) {
        const ok = /^\S+\s+OK/i.test(line);
        return { ok, text: parts.join("\n"), literals };
      }
    }
  }

  async login(user: string, pass: string): Promise<void> {
    const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    const r = await this.command(`LOGIN ${q(user)} ${q(pass)}`);
    if (!r.ok) {
      // Последняя (тегованная) строка часто содержит причину отказа.
      const lines = r.text.split("\n");
      const reason = (lines[lines.length - 1] || "").replace(/^\S+\s+(NO|BAD)\s*/i, "").trim();
      throw new Error("IMAP LOGIN отклонён: " + (reason || "сервер не указал причину"));
    }
  }

  async selectInbox(): Promise<SelectInfo> {
    const r = await this.command("SELECT INBOX");
    if (!r.ok) throw new Error("IMAP SELECT INBOX не удался");
    const uv = r.text.match(/UIDVALIDITY (\d+)/i);
    const un = r.text.match(/UIDNEXT (\d+)/i);
    return {
      uidValidity: uv ? parseInt(uv[1], 10) : 0,
      uidNext: un ? parseInt(un[1], 10) : 0,
    };
  }

  // UID писем от avito.ru с UID > sinceUid.
  async searchAvito(sinceUid: number): Promise<number[]> {
    const from = Math.max(1, sinceUid + 1);
    const r = await this.command(`UID SEARCH UID ${from}:* FROM "avito.ru"`);
    if (!r.ok) return [];
    const line = r.text.split(/\n/).find((l) => /\* SEARCH/i.test(l)) || "";
    const nums = (line.replace(/.*SEARCH/i, "").match(/\d+/g) || []).map((x) => parseInt(x, 10));
    // Отсекаем возможные UID <= sinceUid (на всякий случай).
    return nums.filter((u) => u > sinceUid);
  }

  // Заголовки для набора UID (тело не запрашивается).
  async fetchHeaders(uids: number[]): Promise<MailHeaders[]> {
    if (uids.length === 0) return [];
    const set = uids.join(",");
    const r = await this.command(
      `UID FETCH ${set} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID DATE)])`,
    );
    if (!r.ok) throw new Error("IMAP FETCH заголовков не удался");
    // UID идут в тексте по порядку, литералы — в том же порядке.
    const uidMatches = [...r.text.matchAll(/UID (\d+)/gi)].map((mm) => parseInt(mm[1], 10));
    const out: MailHeaders[] = [];
    const count = Math.min(uidMatches.length, r.literals.length);
    for (let i = 0; i < count; i++) {
      const h = parseHeaderBlock(r.literals[i]);
      out.push({
        uid: uidMatches[i],
        from: decodeRfc2047(h["from"] || ""),
        subject: decodeRfc2047(h["subject"] || ""),
        messageId: (h["message-id"] || "").replace(/[<>]/g, "").trim(),
        date: h["date"] || "",
      });
    }
    return out;
  }

  // Тела писем (TEXT) для набора UID. Возвращает map uid → сниппет тела (первые ~8 КБ).
  // Декодирует quoted-printable/base64, если указан Content-Transfer-Encoding.
  // Ошибки на конкретном UID не валят всю выборку — просто пропускаем.
  async fetchBodies(uids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (uids.length === 0) return out;
    // Тянем по одному, чтобы литералы гарантированно совпали с UID.
    for (const uid of uids) {
      try {
        // Всё письмо целиком (до 256 КБ) и полноценный разбор MIME.
        const full = await this.command(`UID FETCH ${uid} (BODY.PEEK[]<0.262144>)`);
        if (full.ok && full.literals.length > 0) {
          const raw = full.literals.reduce((a, b) => (b.length > a.length ? b : a), "");
          const text = mimeToText(raw);
          if (text) { out.set(uid, text.slice(0, 20000)); continue; }
        }
      } catch { /* пробуем старый способ */ }
      try {
        const r = await this.command(`UID FETCH ${uid} (BODY.PEEK[TEXT]<0.8192> BODY.PEEK[HEADER.FIELDS (CONTENT-TRANSFER-ENCODING CONTENT-TYPE)])`);
        if (!r.ok || r.literals.length === 0) continue;
        // Обычно два литерала: header (первым или вторым — по формату сервера) и body.
        // Определяем body как самый длинный литерал.
        let bodyRaw = r.literals[0];
        let headerRaw = "";
        if (r.literals.length >= 2) {
          if (r.literals[1].length > r.literals[0].length) {
            bodyRaw = r.literals[1];
            headerRaw = r.literals[0];
          } else {
            headerRaw = r.literals[1];
          }
        }
        const h = parseHeaderBlock(headerRaw);
        const enc = String(h["content-transfer-encoding"] || "").toLowerCase();
        const ctype = String(h["content-type"] || "").toLowerCase();
        const charsetMatch = ctype.match(/charset\s*=\s*"?([^";]+)"?/);
        const charset = (charsetMatch ? charsetMatch[1] : "utf-8").trim();
        let decoded = bodyRaw;
        try {
          if (enc === "base64") {
            const bin = atob(bodyRaw.replace(/\s+/g, ""));
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            decoded = new TextDecoder(charset).decode(bytes);
          } else if (enc === "quoted-printable") {
            const bytes: number[] = [];
            const s = bodyRaw.replace(/=\r?\n/g, "");
            for (let i = 0; i < s.length; i++) {
              if (s[i] === "=" && i + 2 < s.length) {
                bytes.push(parseInt(s.substr(i + 1, 2), 16));
                i += 2;
              } else {
                bytes.push(s.charCodeAt(i));
              }
            }
            decoded = new TextDecoder(charset).decode(Uint8Array.from(bytes));
          } else if (charset && charset !== "utf-8") {
            const bytes = Uint8Array.from(bodyRaw, (c) => c.charCodeAt(0));
            decoded = new TextDecoder(charset).decode(bytes);
          }
        } catch { /* оставляем bodyRaw как есть */ }
        // Убираем HTML-теги и лишние пробелы, чтобы упростить поиск ключевых фраз.
        const plain = decoded
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .trim();
        out.set(uid, plain.slice(0, 4000));
      } catch { /* пропускаем письмо */ }
    }
    return out;
  }

  async logout(): Promise<void> {
    try { await this.command("LOGOUT"); } catch { /* ignore */ }
    try { this.conn?.close(); } catch { /* ignore */ }
    this.conn = null;
  }
}

// ─── Классификация письма по теме и телу ─────────────────────────────────────
// Новые типы:
//   "review"  — гость поставил оценку/оставил отзыв («Вы получили оценку 5», «Новый отзыв»)
//   "unlocked" — «Ограничения в чате сняты»: теперь доступен телефон гостя
//   "service" — служебное письмо от Авито, о котором пользователю знать не нужно
//               («Оставьте отзыв о госте», «В чат вернулись ограничения»)
export type AvitoKind = "request" | "paid" | "message" | "cancel" | "review" | "unlocked" | "service" | "other";

// Классификация по теме (быстрый первый проход, без чтения тела).
export function classifyAvito(subject: string): AvitoKind {
  const s = (subject || "").toLowerCase();
  if (s.includes("отмен")) return "cancel";          // «Гость отменил бронь», «Бронирование отменено»
  if (s.includes("мгновенн")) return "request";      // «У вас мгновенная бронь»
  if (s.includes("оплат") || s.includes("оплачен")) return "paid"; // «Гость оплатил жильё»
  // Отзыв/оценка: «Вы получили оценку 5», «Новый отзыв», «Пользователь оставил отзыв».
  if (s.includes("оценк") || s.includes("отзыв")) return "review";
  if (s.includes("сообщени")) return "message";      // «Вам пришло новое сообщение»
  return "other";
}

// Уточнение по телу письма: тема «сообщение» может маскировать служебку
// («Ограничения в чате сняты», «Оставьте отзыв», «В чат вернулись ограничения»).
// Также извлекаем текст отзыва и оценку для типа "review".
export interface RefinedKind {
  kind: AvitoKind;
  reviewText?: string; // текст отзыва (для review)
  reviewRating?: number; // оценка 1–5 (для review)
}

export function refineByBody(kind: AvitoKind, body: string): RefinedKind {
  // Нормализация: нижний регистр, ё→е, любые пробелы → один пробел.
  const b = (body || "").toLowerCase().replace(/ё/g, "е").replace(/[\s\u00a0]+/g, " ");
  // «Ограничения в чате сняты» — отдельное уведомление про доступный телефон гостя.
  if (/ограничения в чате сняты/.test(b)) return { kind: "unlocked" };
  // Служебные маркеры (в теле любого письма) — не показываем.
  const isService =
    b.includes("в чат вернулись ограничения") ||
    b.includes("в чате вернулись ограничения") ||
    b.includes("ограничения в чате возвращены") ||
    b.includes("оставьте отзыв о госте") ||
    b.includes("оставьте отзыв о продавце");
  if (isService) return { kind: "service" };
  // Отзыв в теле — гарантия, что это "review" даже если тема была "other".
  if (b.includes("новый отзыв") || /получили оценку\s+\d/.test(b)) {
    const ratingMatch = body.match(/оценку\s+([1-5])/i) || body.match(/★{1,5}|\*{1,5}/);
    const rating = ratingMatch && ratingMatch[1] ? Number(ratingMatch[1]) : undefined;
    // Пытаемся достать текст отзыва: часто идёт после блока «Сделка состоялась:» + название объявления.
    // Простая эвристика — берём фразу после последнего «Приедем» или ищем длинный фрагмент между
    // блоком с объявлением и словом «Ответить». Если не нашли — просто оставим пусто.
    let text: string | undefined;
    const m = body.match(/(?:Приедем[^]*?|кровать[^]*?|м²[^]*?)\.\s*([А-ЯЁ][^]{20,400}?)\s*Ответить/i);
    if (m) text = m[1].trim();
    return { kind: "review", reviewText: text, reviewRating: rating };
  }
  return { kind };
}

// Проверка, что отправитель действительно с домена avito.ru.
export function isFromAvito(from: string): boolean {
  const m = (from || "").match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).toLowerCase().trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return false;
  const domain = addr.slice(at + 1);
  return domain === "avito.ru" || domain.endsWith(".avito.ru");
}

// Текст уведомления в Telegram (без персональных данных).
// Возвращает null для типов, которые НЕ нужно показывать пользователю
// (service, other) — такие письма пропускаются в poll'е.
export function notifyText(kind: AvitoKind, extra?: { reviewText?: string; reviewRating?: number }): string | null {
  switch (kind) {
    case "request":
      return "🆕 <b>Новая мгновенная бронь на Авито</b>\nГость оставил заявку — ждём предоплату (обычно 2 часа). Напишите гостю, чтобы ускорить решение.";
    case "paid":
      return "✅ <b>Гость оплатил — бронь подтверждена</b> (Авито).";
    case "message":
      return "✉️ <b>Гость ждёт ответа — уже ~15 минут</b> (Авито).\nСообщение осталось без ответа 15 минут. Ответьте сейчас — быстрый ответ часто решает бронь.";
    case "cancel":
      return "❌ <b>Гость отменил бронь</b> (Авито).\nДаты снова свободны — проверьте календарь и при необходимости откройте их для новых броней.";
    case "review": {
      const stars = extra?.reviewRating ? "⭐".repeat(Math.max(1, Math.min(5, extra.reviewRating))) : "";
      const header = extra?.reviewRating
        ? `👍 <b>Гость оценил проживание: ${extra.reviewRating}/5</b> ${stars} (Авито).`
        : "👍 <b>Гость оставил отзыв</b> (Авито).";
      const body = extra?.reviewText ? `\n\n<i>${extra.reviewText.replace(/[<>]/g, "")}</i>` : "";
      return header + body;
    }
    case "unlocked":
      return "📞 <b>Телефон гостя теперь доступен</b> (Авито).\nОграничения в чате сняты — гостю можно позвонить или написать напрямую.";
    case "service":
    case "other":
    default:
      return null;
  }
}
