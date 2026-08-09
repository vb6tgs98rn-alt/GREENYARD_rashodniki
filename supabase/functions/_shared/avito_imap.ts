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
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
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
  }).replace(/\?=\s+=\?/g, "?==?"); // склейка соседних encoded-words
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
    if (!r.ok) throw new Error("IMAP LOGIN отклонён (проверьте почту и пароль приложения)");
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

  async logout(): Promise<void> {
    try { await this.command("LOGOUT"); } catch { /* ignore */ }
    try { this.conn?.close(); } catch { /* ignore */ }
    this.conn = null;
  }
}

// ─── Классификация письма по теме ────────────────────────────────────────────
export type AvitoKind = "request" | "paid" | "message" | "other";

export function classifyAvito(subject: string): AvitoKind {
  const s = (subject || "").toLowerCase();
  if (s.includes("мгновенн")) return "request";
  if (s.includes("оплатил") || s.includes("оплачен")) return "paid";
  if (s.includes("новое сообщение") || s.includes("сообщение")) return "message";
  return "other";
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
export function notifyText(kind: AvitoKind): string {
  switch (kind) {
    case "request":
      return "🆕 <b>Новая мгновенная бронь на Авито</b>\nГость оставил заявку — ждём предоплату (обычно 2 часа). Напишите гостю, чтобы ускорить решение.";
    case "paid":
      return "✅ <b>Гость оплатил — бронь подтверждена</b> (Авито).";
    case "message":
      return "✉️ <b>Гость ждёт ответа — уже ~15 минут</b> (Авито).\nСообщение осталось без ответа 15 минут. Ответьте сейчас — быстрый ответ часто решает бронь.";
    default:
      return "🔔 <b>Новое уведомление от Авито</b>.";
  }
}
