"use strict";
/* =========================================================
   Пакетная загрузка.
   API «Метафоры» принимает один XML за запрос, поэтому пакет —
   это очередь: файлы уходят по одному, затем статусы
   опрашиваются, пока все не будут обработаны.

   jats    — много JATS XML + PDF, пары по имени файла
             (719667.xml ↔ 719667.pdf), запасные ключи: DOI,
             publisher-id. Каждая пара: POST files/jats/xml_pdf/.
   journal — один Journal XML выпуска + PDF. После обработки
             PDF раскладываются по статьям (подсказка по DOI
             и страницам в имени файла), затем
             POST publications/{uid}/pdf/ для каждой.
   ========================================================= */

const B = {
  mode: "jats",
  rows: [],          // строки таблицы
  pdfs: [],          // все выбранные PDF (File)
  issueXml: null,    // journal: XML выпуска
  issue: null,       // journal: { fileUid, code, state, msg }
  running: false,
  stop: false,
};
const POLL_MS = 4000;
const POLL_LIMIT_MS = 15 * 60 * 1000;

const baseName = (n) => n.replace(/\.[^.]+$/, "").trim().toLowerCase();
const doiTail = (doi) => (doi || "").split("/").pop().toLowerCase();
const isXml = (f) => /\.xml$/i.test(f.name) || /xml/.test(f.type);
const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";

/* ---------- разбор JATS в браузере ---------- */
function langOf(el) {
  for (let e = el; e && e.getAttribute; e = e.parentElement) {
    const l = e.getAttribute("xml:lang");
    if (l) return l.toLowerCase();
  }
  return "";
}
function jatsInfo(text) {
  const d = new DOMParser().parseFromString(text, "application/xml");
  if (d.getElementsByTagName("parsererror").length) return { error: "XML не разбирается" };
  const root = d.documentElement;
  if (root.nodeName !== "article") return { error: `Корень <${root.nodeName}>, а не <article> — это не JATS` };
  const meta = root.getElementsByTagName("article-meta")[0];
  if (!meta) return { error: "Нет <article-meta>" };
  const ids = [...meta.getElementsByTagName("article-id")];
  const idOf = (t) => (ids.find((x) => x.getAttribute("pub-id-type") === t)?.textContent || "").trim();
  const titles = [...meta.getElementsByTagName("article-title"), ...meta.getElementsByTagName("trans-title")]
    .map((t) => ({ lang: langOf(t), text: t.textContent.replace(/\s+/g, " ").trim() }))
    .filter((t) => t.text);
  const title = (titles.find((t) => t.lang === "ru") || titles[0] || {}).text || "";
  const txt = (tag) => (meta.getElementsByTagName(tag)[0]?.textContent || "").trim();
  const fp = txt("fpage"), lp = txt("lpage");
  return {
    doi: idOf("doi"), pid: idOf("publisher-id"), title,
    vol: txt("volume"), iss: txt("issue"),
    pages: fp ? (lp && lp !== fp ? `${fp}-${lp}` : fp) : "",
  };
}

/* ---------- приём файлов ---------- */
async function addFiles(list) {
  const files = [...list].filter((f) => f.size > 0 && (isXml(f) || isPdf(f)));
  const skipped = list.length - files.length;
  const newPdfs = files.filter(isPdf);
  const newXml = files.filter(isXml);
  // PDF с тем же именем заменяют прежний
  for (const p of newPdfs) {
    const i = B.pdfs.findIndex((x) => x.name === p.name);
    if (i >= 0) B.pdfs[i] = p; else B.pdfs.push(p);
  }
  if (B.mode === "journal") {
    if (newXml.length) B.issueXml = newXml[newXml.length - 1];
    if (B.issue?.state === "done") suggestJournalPdfs();
  } else {
    for (const x of newXml) {
      const info = jatsInfo(await x.text());
      const old = B.rows.find((r) => r.xml.name === x.name);
      const row = old || { id: Math.random().toString(36).slice(2), state: "ready" };
      Object.assign(row, { xml: x, info, state: info.error ? "invalid" : (old?.state === "done" ? old.state : "ready"),
        msg: info.error || "" });
      if (!old) B.rows.push(row);
    }
    pairJats();
  }
  if (B.mode === "jats") B.rows.sort((a, b) => a.xml.name.localeCompare(b.xml.name, "ru", { numeric: true }));
  bNote(skipped ? `<div class="note">Пропущено файлов не XML/PDF: ${skipped}</div>` : "");
  renderBatch();
}

function pairJats() {
  const used = new Set(B.rows.filter((r) => r.pdfManual && r.pdf).map((r) => r.pdf.name));
  for (const r of B.rows) {
    if (r.pdfManual) continue;
    const keys = [baseName(r.xml.name), (r.info.pid || "").toLowerCase()].filter(Boolean);
    const tail = doiTail(r.info.doi);
    const free = B.pdfs.filter((p) => !used.has(p.name));
    const pdf = free.find((p) => keys.includes(baseName(p.name)))
      || (tail.length > 5 ? free.find((p) => baseName(p.name).includes(tail)) : null);
    r.pdf = pdf || null;
    if (pdf) used.add(pdf.name);
  }
}

/* ---------- отрисовка ---------- */
const STATE = {
  ready: ["готова", ""], nopdf: ["без PDF", "b-warn"], invalid: ["не JATS", "b-bad"],
  uploading: ["загрузка…", "b-run"], processing: ["обработка…", "b-run"], pdf: ["PDF…", "b-run"],
  done: ["обработана", "b-ok"], signing: ["подпись…", "b-run"], signed: ["подписана", "b-ok"],
  error: ["ошибка", "b-bad"], failed: ["ошибка обработки", "b-bad"], stopped: ["остановлено", "b-warn"],
};
function stBadge(r) {
  const key = r.state === "ready" && !r.pdf ? "nopdf" : r.state;
  const [t, c] = STATE[key] || [key, ""];
  return `<span class="badge ${c}"><span class="dot"></span>${t}</span>`;
}
function pdfSelect(r, i) {
  const opts = [`<option value="">— без PDF —</option>`].concat(
    B.pdfs.map((p, k) => `<option value="${k}" ${r.pdf === p ? "selected" : ""}>${esc(p.name)}</option>`));
  const locked = B.running || ["uploading", "processing", "pdf", "done", "signing", "signed"].includes(r.state) && (B.mode === "jats" || r.pdfDone);
  return `<select data-row="${i}" class="${r.pdf ? "" : "warn"}" ${locked ? "disabled" : ""}>${opts.join("")}</select>`;
}

function counts() {
  const c = {};
  for (const r of B.rows) {
    const k = r.state === "ready" && !r.pdf ? "nopdf" : r.state;
    c[k] = (c[k] || 0) + 1;
  }
  return c;
}

function renderBatch() {
  const jats = B.mode === "jats";
  $("#bHint").textContent = jats
    ? "Выберите сразу все JATS XML и PDF номера. Пары подбираются по имени файла (719667.xml ↔ 719667.pdf), а если имена разные — по DOI или publisher-id в имени PDF. Пару можно поправить вручную."
    : "Выберите XML выпуска (journal3) и PDF всех статей. Сначала загружается XML; после обработки появится список статей, PDF разложатся по ним по DOI или страницам в имени файла — проверьте и загрузите.";
  $("#bDropTitle").textContent = jats ? "Все XML и PDF разом" : "XML выпуска и все PDF";

  const dups = new Map();
  B.rows.forEach((r) => r.pdf && dups.set(r.pdf.name, (dups.get(r.pdf.name) || 0) + 1));
  const dupDoi = new Map();
  B.rows.forEach((r) => r.info?.doi && dupDoi.set(r.info.doi, (dupDoi.get(r.info.doi) || 0) + 1));

  // сводка
  const parts = [];
  if (!jats && (B.issueXml || B.issue)) {
    const is = B.issue;
    const st = is ? stBadge({ state: is.state, pdf: true }) : '<span class="badge"><span class="dot"></span>XML выпуска выбран</span>';
    parts.push(`<span class="badge"><span class="dot"></span>XML&nbsp;<b>${esc(B.issueXml?.name || "")}</b></span>${st}`);
  }
  if (B.rows.length) {
    parts.push(`<span class="badge"><span class="dot"></span>статей <b>${B.rows.length}</b></span>`);
    parts.push(`<span class="badge"><span class="dot"></span>PDF <b>${B.pdfs.length}</b>, в парах <b>${B.rows.filter((r) => r.pdf).length}</b></span>`);
    const c = counts();
    for (const k of ["nopdf", "invalid", "done", "signed", "error", "failed"]) {
      if (c[k]) parts.push(`<span class="badge ${STATE[k][1]}"><span class="dot"></span>${STATE[k][0]} <b>${c[k]}</b></span>`);
    }
  } else if (B.pdfs.length) {
    parts.push(`<span class="badge"><span class="dot"></span>PDF <b>${B.pdfs.length}</b></span>`);
  }
  const unpaired = B.pdfs.filter((p) => !B.rows.some((r) => r.pdf === p));
  if (B.rows.length && unpaired.length) parts.push(`<span class="badge b-warn"><span class="dot"></span>PDF без пары <b>${unpaired.length}</b></span>`);
  $("#bSummary").hidden = !parts.length;
  $("#bSummary").innerHTML = parts.join("");

  // таблица
  if (!B.rows.length) {
    $("#bTable").innerHTML = !jats && B.issue && B.issue.state !== "done" && B.issue.state !== "failed" && B.issue.state !== "error"
      ? '<p class="hint">Ждём обработки XML выпуска…</p>' : "";
  } else {
    $("#bTable").innerHTML = `<div class="table-wrap"><table class="btable"><thead><tr>
      <th>#</th><th>Статья</th><th>Стр.</th><th>PDF</th><th>Статус</th></tr></thead><tbody>${B.rows.map((r, i) => {
      const warns = [];
      if (r.pdf && dups.get(r.pdf.name) > 1) warns.push("этот PDF выбран для нескольких статей");
      if (r.info?.doi && dupDoi.get(r.info.doi) > 1) warns.push("DOI повторяется в пакете");
      const link = r.articleUid ? `<button class="link" data-open-art="${esc(r.articleUid)}">открыть →</button>` : "";
      return `<tr class="${["error", "failed", "invalid"].includes(r.state) ? "row-err" : ""}">
        <td class="num">${i + 1}</td>
        <td><div class="t">${esc((r.info?.title || "").slice(0, 140) || "—")}</div>
          <div class="sub-m">${esc(r.info?.doi || "без DOI")}${r.xml ? " · " + esc(r.xml.name) : ""}</div></td>
        <td class="num">${esc(r.info?.pages || "—")}</td>
        <td>${pdfSelect(r, i)}</td>
        <td>${stBadge(r)} ${link}
          ${r.msg ? `<div class="msg ${r.msgInfo ? "info" : ""}">${esc(r.msg)}</div>` : ""}
          ${warns.length ? `<div class="msg">${esc(warns.join("; "))}</div>` : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }

  // кнопки
  const any = B.rows.length || B.pdfs.length || B.issueXml;
  $("#bActions").hidden = !any;
  const c = counts();
  const ready = jats ? B.rows.filter((r) => ["ready", "stopped"].includes(r.state)).length : 0;
  const journalPdfReady = !jats && B.issue?.state === "done" ? B.rows.filter((r) => r.pdf && !r.pdfDone && r.state !== "signed").length : 0;
  const start = $("#bStart");
  if (jats) { start.textContent = ready ? `Загрузить ${ready} ${plural(ready, "статью", "статьи", "статей")}` : "Загрузить"; start.disabled = B.running || !ready; }
  else if (!B.issue || ["error", "stopped", "failed"].includes(B.issue.state)) { start.textContent = "Загрузить XML выпуска"; start.disabled = B.running || !B.issueXml; }
  else { start.textContent = journalPdfReady ? `Загрузить PDF к ${journalPdfReady} ${plural(journalPdfReady, "статье", "статьям", "статьям")}` : "Загрузить PDF"; start.disabled = B.running || !journalPdfReady; }
  $("#bStop").hidden = !B.running;
  $("#bRetry").hidden = B.running || !c.error;
  const signable = B.rows.filter((r) => r.state === "done" && r.articleUid).length;
  $("#bSign").hidden = B.running || !signable;
  $("#bSign").textContent = `Подписать обработанные (${signable})`;
  $("#bCsv").hidden = !B.rows.some((r) => r.fileUid || r.articleUid || r.state !== "ready");
  $("#bClear").disabled = B.running;
  $$("#bModeSeg .seg-btn").forEach((b) => (b.disabled = B.running));
}
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const bNote = (html) => ($("#bNote").innerHTML = html);

function errText(res) {
  const d = res.data && typeof res.data === "object" ? res.data : {};
  let t = (d.message || `HTTP ${res.status}`) + (d.error ? ` (${d.error})` : "");
  const inner = d.data || {};
  if (Array.isArray(inner.errors) && inner.errors.length) t += ": " + inner.errors.slice(0, 3).join("; ");
  else if (inner.description) t += ": " + String(inner.description).split("\n").filter(Boolean)[0];
  else if (d.errors) t += ": " + Object.values(d.errors).flat().slice(0, 2).join("; ");
  return t;
}

/* ---------- JATS: загрузка очереди ---------- */
async function runJats(onlyRetry) {
  const queue = B.rows.filter((r) => onlyRetry ? r.state === "error" : ["ready", "stopped"].includes(r.state));
  if (!queue.length) return;
  const noPdf = queue.filter((r) => !r.pdf).length;
  if (noPdf && !confirm(`${noPdf} ${plural(noPdf, "статья уйдёт", "статьи уйдут", "статей уйдут")} без PDF. PDF можно будет догрузить позже. Продолжить?`)) return;
  B.running = true; B.stop = false; renderBatch();
  for (const r of queue) {
    if (B.stop) { r.state = "stopped"; continue; }
    r.state = "uploading"; r.msg = ""; r.msgInfo = false; renderBatch();
    const form = { xml: r.xml };
    if (r.pdf) form.pdf = r.pdf;
    const res = await call("POST", r.pdf ? "/api/v2/files/jats/xml_pdf/" : "/api/v2/files/jats/xml/", { form });
    if (res.ok && res.data?.data?.file_uid) {
      r.fileUid = res.data.data.file_uid; r.state = "processing"; r.pdfSent = !!r.pdf;
      addHistory({ file_uid: r.fileUid, name: r.xml.name, mode: r.pdf ? "jats_pdf" : "jats", at: new Date().toISOString(), code: 1, pdf: !!r.pdf });
    } else if (res.data?.error === "XML_ALREADY_EXISTS" && res.data?.data?.exists_file_uid) {
      r.fileUid = res.data.data.exists_file_uid; r.state = "processing"; r.pdfSent = false;
      r.msg = "уже был загружен ранее"; r.msgInfo = true;
    } else {
      r.state = "error"; r.msg = errText(res);
    }
    renderBatch();
  }
  await pollRows(B.rows.filter((r) => r.state === "processing"));
  B.running = false; renderBatch();
  summaryNote();
}

async function pollRows(rows) {
  const t0 = Date.now();
  let pending = rows.slice();
  while (pending.length && !B.stop && Date.now() - t0 < POLL_LIMIT_MS) {
    for (const r of pending) {
      const res = await call("GET", "/api/v2/files/status/", { query: { file_uid: r.fileUid }, silent: true });
      if (!res.ok) { pushLog(res.entry); r.state = "error"; r.msg = errText(res); continue; }
      const d = res.data.data || {};
      const code = d.xml?.status?.code;
      if (code !== r.code) { pushLog(res.entry); r.code = code; }
      patchHistory(r.fileUid, { code, pdf: !!d.pdf?.status?.uploaded, articles: d.articles || [] });
      if (code === 4) { r.state = "failed"; r.msg = "«Метафора» не смогла обработать XML. Исправьте файл и добавьте его заново (тот же файл получит «уже загружен»); неудачный можно удалить во вкладке «Файлы»."; }
      if (code === 3) {
        r.articleUid = (d.articles || [])[0] || null;
        if (d.articles?.length > 1) { r.msg = `создано статей: ${d.articles.length}`; r.msgInfo = true; }
        // уже загруженный ранее XML: PDF пары догружаем отдельно
        if (r.pdf && !r.pdfSent && !d.pdf?.status?.uploaded) {
          r.state = "pdf"; renderBatch();
          const p = await call("POST", "/api/v2/files/pdf/", { query: { file_uid: r.fileUid }, form: { pdf: r.pdf } });
          r.pdfSent = p.ok || p.status === 409;
          if (!p.ok && p.status !== 409) { r.msg = "XML обработан, PDF не загрузился: " + errText(p); r.msgInfo = false; }
        }
        r.state = "done";
      }
    }
    renderBatch();
    pending = pending.filter((r) => r.state === "processing");
    if (pending.length) await sleep(POLL_MS);
  }
  for (const r of pending) { r.msg = B.stop ? "опрос остановлен — проверьте статус позже" : "обработка идёт дольше 15 минут — проверьте статус позже"; r.msgInfo = true; }
}

/* ---------- Journal: выпуск ---------- */
async function runJournalXml() {
  B.running = true; B.stop = false; B.rows = [];
  B.issue = { state: "uploading" }; renderBatch();
  const res = await call("POST", "/api/v2/files/journal/", { form: { xml: B.issueXml } });
  let uid = res.data?.data?.file_uid;
  if (!res.ok && res.data?.error === "XML_ALREADY_EXISTS") { uid = res.data?.data?.exists_file_uid; }
  if (!uid) {
    B.issue = { state: "error", msg: errText(res) }; B.running = false; renderBatch();
    bNote(errorHtml(res)); return;
  }
  if (res.ok) addHistory({ file_uid: uid, name: B.issueXml.name, mode: "journal", at: new Date().toISOString(), code: 1 });
  B.issue = { fileUid: uid, state: "processing" };
  bNote(`<div class="note"><b>${res.ok ? "XML выпуска принят" : "Этот XML уже был загружен"}</b><span class="code-tag">file_uid ${esc(uid)}</span></div>`);
  renderBatch();
  const row = { fileUid: uid, state: "processing" };
  await pollRows([row]);
  if (row.state !== "done") {
    B.issue.state = row.state === "processing" ? "stopped" : row.state; B.issue.msg = row.msg;
    B.running = false; renderBatch(); bNote(`<div class="note err"><b>${esc(row.msg || "Выпуск не обработан")}</b></div>`); return;
  }
  // статьи выпуска
  const st = await call("GET", "/api/v2/files/status/", { query: { file_uid: uid }, silent: true });
  const arts = st.data?.data?.articles || [];
  B.issue.state = "done";
  B.rows = [];
  for (const a of arts) {
    const p = await call("GET", `/api/v2/publications/${encodeURIComponent(a)}`, { silent: true });
    const loc = p.data?.article || {};
    const l = loc.RUS || Object.values(loc)[0] || {};
    B.rows.push({
      articleUid: a, state: "done",
      info: { doi: l.doi || "", title: l.title || "", pages: l.fpage ? (l.lpage && l.lpage !== l.fpage ? `${l.fpage}-${l.lpage}` : `${l.fpage}`) : "", fp: l.fpage },
    });
  }
  B.rows.sort((x, y) => (x.info.fp || 0) - (y.info.fp || 0));
  suggestJournalPdfs();
  B.running = false; renderBatch();
  bNote(`<div class="note ok"><b>Выпуск обработан: статей ${arts.length}</b> Проверьте, какой PDF к какой статье подобран, и нажмите «Загрузить PDF».</div>`);
}

function suggestJournalPdfs() {
  const used = new Set(B.rows.filter((r) => r.pdf).map((r) => r.pdf.name));
  for (const r of B.rows) {
    if (r.pdf || r.pdfManual) continue;
    const free = B.pdfs.filter((p) => !used.has(p.name));
    const tail = doiTail(r.info.doi);
    const pages = r.info.pages;
    const pick = (tail.length > 5 && free.find((p) => baseName(p.name).includes(tail)))
      || (pages && free.find((p) => new RegExp(`(^|[^0-9])${pages.replace("-", "[-–_]")}([^0-9]|$)`).test(baseName(p.name))));
    if (pick) { r.pdf = pick; used.add(pick.name); }
  }
}

async function runJournalPdfs(onlyRetry) {
  const queue = B.rows.filter((r) => r.pdf && !r.pdfDone && (onlyRetry ? r.state === "error" : r.state !== "signed"));
  if (!queue.length) return;
  B.running = true; B.stop = false; renderBatch();
  for (const r of queue) {
    if (B.stop) break;
    r.state = "pdf"; r.msg = ""; renderBatch();
    const res = await call("POST", `/api/v2/publications/${encodeURIComponent(r.articleUid)}/pdf/`, { form: { pdf: r.pdf } });
    if (res.ok) { r.pdfDone = true; r.state = "done"; r.msg = "PDF загружен"; r.msgInfo = true; }
    else { r.state = "error"; r.msg = errText(res); r.msgInfo = false; }
    renderBatch();
  }
  B.running = false; renderBatch(); summaryNote();
}

/* ---------- подписание всех ---------- */
async function signAll() {
  const list = B.rows.filter((r) => r.state === "done" && r.articleUid);
  if (!list.length) return;
  const noPdf = B.mode === "jats" ? list.filter((r) => !r.pdf).length : list.filter((r) => !r.pdfDone).length;
  const warn = noPdf ? `\n\nВнимание: у ${noPdf} из них PDF не загружался в этом пакете. После подписания PDF загрузить нельзя, пока подпись не отозвана.` : "";
  if (!confirm(`Подписать ${list.length} ${plural(list.length, "публикацию", "публикации", "публикаций")} от имени организации?${warn}\n\nСначала стоит открыть одну-две и проверить метаданные RUS/ENG.`)) return;
  B.running = true; B.stop = false; renderBatch();
  for (const r of list) {
    if (B.stop) break;
    r.state = "signing"; renderBatch();
    const res = await call("PUT", `/api/v2/publications/${encodeURIComponent(r.articleUid)}/sign/`);
    if (res.ok || res.status === 409) { r.state = "signed"; r.msg = res.ok ? "" : "уже была подписана"; r.msgInfo = true; }
    else { r.state = "done"; r.msg = "не подписана: " + errText(res); r.msgInfo = false; }
    renderBatch();
  }
  B.running = false; renderBatch(); summaryNote();
}

function summaryNote() {
  const c = counts();
  const bits = [];
  if (c.done) bits.push(`обработано ${c.done}`);
  if (c.signed) bits.push(`подписано ${c.signed}`);
  if (c.error || c.failed) bits.push(`с ошибками ${(c.error || 0) + (c.failed || 0)}`);
  if (c.stopped) bits.push(`не отправлено ${c.stopped}`);
  if (bits.length) bNote(`<div class="note ${c.error || c.failed ? "err" : "ok"}"><b>Готово: ${bits.join(", ")}</b></div>`);
}

/* ---------- отчёт ---------- */
function exportCsv() {
  const head = ["n", "xml", "pdf", "doi", "pages", "title", "file_uid", "article_uid", "status", "message"];
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(";")].concat(B.rows.map((r, i) => [i + 1, r.xml?.name || B.issueXml?.name || "", r.pdf?.name || "",
    r.info?.doi, r.info?.pages, r.info?.title, r.fileUid || B.issue?.fileUid || "", r.articleUid || "",
    (STATE[r.state] || [r.state])[0], r.msg || ""].map(q).join(";")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `metafora-paket-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------- события ---------- */
function resetBatch() {
  Object.assign(B, { rows: [], pdfs: [], issueXml: null, issue: null, stop: false });
  $("#bFiles").value = ""; bNote(""); renderBatch();
}
$$("#bModeSeg .seg-btn").forEach((b) => b.addEventListener("click", () => {
  if (B.running || b.dataset.bmode === B.mode) return;
  if ((B.rows.length || B.pdfs.length || B.issueXml) && !confirm("Сменить режим? Выбранные файлы и таблица очистятся.")) return;
  B.mode = b.dataset.bmode;
  $$("#bModeSeg .seg-btn").forEach((x) => x.classList.toggle("is-on", x === b));
  resetBatch();
}));
$("#bFiles").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const bDrop = $("#bDrop");
["dragenter", "dragover"].forEach((t) => bDrop.addEventListener(t, (e) => { e.preventDefault(); bDrop.classList.add("is-over"); }));
["dragleave", "drop"].forEach((t) => bDrop.addEventListener(t, () => bDrop.classList.remove("is-over")));
bDrop.addEventListener("drop", (e) => { e.preventDefault(); if (!B.running) addFiles(e.dataTransfer.files); });

$("#bTable").addEventListener("change", (e) => {
  const s = e.target.closest("select[data-row]"); if (!s) return;
  const r = B.rows[+s.dataset.row];
  r.pdf = s.value === "" ? null : B.pdfs[+s.value];
  r.pdfManual = true;
  renderBatch();
});
$("#bStart").addEventListener("click", () => {
  if (B.mode === "jats") return runJats(false);
  if (!B.issue || ["error", "stopped", "failed"].includes(B.issue.state)) return runJournalXml();
  return runJournalPdfs(false);
});
$("#bRetry").addEventListener("click", () => (B.mode === "jats" ? runJats(true) : runJournalPdfs(true)));
$("#bStop").addEventListener("click", () => { B.stop = true; $("#bStop").disabled = true; setTimeout(() => ($("#bStop").disabled = false), 1500); });
$("#bSign").addEventListener("click", signAll);
$("#bCsv").addEventListener("click", exportCsv);
$("#bClear").addEventListener("click", () => {
  if (B.rows.some((r) => r.fileUid || r.articleUid) && !confirm("Очистить таблицу? В «Метафоре» ничего не удаляется, история загрузок остаётся во вкладке «Файлы».")) return;
  resetBatch();
});
window.addEventListener("beforeunload", (e) => { if (B.running) { e.preventDefault(); e.returnValue = ""; } });

renderBatch();
