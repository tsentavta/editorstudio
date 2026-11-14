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

/* =========================================================
   Чтение PDF (PDF.js) и сверка с XML.
   Из первой страницы (при необходимости — второй) берётся текст;
   в нём ищется DOI статьи, а если его нет — заголовок.
   Библиотека грузится с CDN только когда выбраны PDF.
   ========================================================= */
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/";
let pdfjsReady = null;
function loadPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = new Promise((resolve, reject) => {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      const s = document.createElement("script");
      s.src = PDFJS + "pdf.min.js";
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.js"; resolve(window.pdfjsLib); };
      s.onerror = () => { pdfjsReady = null; reject(new Error("не удалось загрузить модуль чтения PDF")); };
      document.head.appendChild(s);
    });
  }
  return pdfjsReady;
}

const normTitle = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]/g, "");
const pdfMeta = new Map();   // имя PDF → { state, compact, norm, pages, dois, error }
let pdfReadBusy = false;

async function readPdfText(file) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let text = "";
  try {
    for (let i = 1; i <= Math.min(2, doc.numPages); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      text += tc.items.map((x) => x.str).join(" ") + "\n";
      if (/10\.\d{4,9}\//.test(text.replace(/\s+/g, ""))) break;
    }
    return { text, pages: doc.numPages };
  } finally { doc.destroy(); }
}

async function readAllPdfs() {
  if (pdfReadBusy) return;
  pdfReadBusy = true;
  try {
    for (const p of B.pdfs.slice()) {
      const m = pdfMeta.get(p.name);
      if (m && m.file === p && m.state !== "reading") continue;
      pdfMeta.set(p.name, { file: p, state: "reading" });
      renderBatch();
      try {
        const { text, pages } = await readPdfText(p);
        const compact = text.toLowerCase().replace(/\s+/g, "");
        pdfMeta.set(p.name, {
          file: p, state: "ok", pages, compact, norm: normTitle(text),
          // для показа — из текста с пробелами, чтобы DOI не слипся со следующим словом
          dois: [...new Set((text.match(/10\.\d{4,9}\/[^\s"'<>,;()\[\]]+/g) || []).map((d) => d.replace(/[.\-]+$/, "").slice(0, 80)))],
        });
      } catch (e) {
        pdfMeta.set(p.name, { file: p, state: "error", error: e.message });
        if (/модуль чтения/.test(e.message)) { bNote(`<div class="note err"><b>Сверка по тексту PDF недоступна:</b> ${esc(e.message)}. Пары подобраны по именам файлов — проверьте их в просмотре.</div>`); break; }
      }
      if (B.mode === "jats") pairJats(); else suggestJournalPdfs();
      renderBatch();
    }
  } finally {
    pdfReadBusy = false;
  }
  // за время чтения могли добавить ещё файлы
  if (B.pdfs.some((p) => !pdfMeta.has(p.name))) readAllPdfs();
}

// есть ли DOI в тексте PDF (после DOI не должна идти цифра: …7-14 ≠ …7-149)
function pdfHasDoi(m, doi) {
  if (!doi || !m?.compact) return false;
  const d = doi.toLowerCase().replace(/\s+/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(d + "(?![0-9])").test(m.compact);
}
function pdfHasTitle(m, title) {
  const t = normTitle(title).slice(0, 60);
  return t.length >= 20 && !!m?.norm && m.norm.includes(t);
}
/** Результат сверки строки с её PDF: doi | title | other | foreign | unknown | reading | error | null */
function verifyRow(r) {
  if (!r.pdf) return null;
  const m = pdfMeta.get(r.pdf.name);
  if (!m || m.state === "reading") return { k: "reading" };
  if (m.state === "error") return { k: "error", msg: m.error };
  if (pdfHasDoi(m, r.info?.doi)) return { k: "doi" };
  const other = B.rows.find((x) => x !== r && pdfHasDoi(m, x.info?.doi));
  if (other) return { k: "other", other };
  if (pdfHasTitle(m, r.info?.title)) return { k: "title" };
  if (m.dois.length) return { k: "foreign", doi: m.dois[0] };
  return { k: "unknown" };
}
const VERIFY = {
  doi: ["✓ DOI в PDF совпадает", "v-ok"],
  title: ["✓ совпал заголовок", "v-ok"],
  other: ["⚠ это PDF другой статьи", "v-bad"],
  foreign: ["⚠ в PDF другой DOI", "v-bad"],
  unknown: ["? DOI и заголовок в PDF не найдены", "v-warn"],
  reading: ["читаю PDF…", "v-dim"],
  error: ["не удалось прочитать PDF", "v-warn"],
};
function verifyHtml(r, rows) {
  const v = verifyRow(r);
  if (!v) return "";
  let t = VERIFY[v.k][0];
  if (v.k === "other") t += ` (#${rows.indexOf(v.other) + 1})`;
  if (v.k === "foreign") t += `: ${v.doi}`;
  return `<div class="verify ${VERIFY[v.k][1]}">${esc(t)}</div>`;
}

/* ---------- URL для просмотра ---------- */
const pdfUrls = new Map();
function pdfUrl(file) {
  const old = pdfUrls.get(file.name);
  if (old && old.file === file) return old.url;
  if (old) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(file);
  pdfUrls.set(file.name, { file, url });
  return url;
}

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
  // авторы: по одному на contrib, предпочтительно на русском
  const authors = [...meta.getElementsByTagName("contrib")]
    .filter((c) => (c.getAttribute("contrib-type") || "author") === "author")
    .map((c) => {
      const names = [...c.getElementsByTagName("name")];
      const n = names.find((x) => langOf(x) === "ru") || names[0];
      if (!n) return "";
      const sn = (n.getElementsByTagName("surname")[0]?.textContent || "").trim();
      const gn = (n.getElementsByTagName("given-names")[0]?.textContent || "").trim();
      return [sn, gn].filter(Boolean).join(" ");
    }).filter(Boolean);
  return {
    authors: authors.join(", "),
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
  renderViewer();
  if (newPdfs.length) readAllPdfs();
}

const pairLocked = (r) => r.pdfManual || !["ready", "stopped", "invalid"].includes(r.state);

/* Подбор PDF к статьям. Порядок: DOI в тексте PDF → имя файла
   (имя XML, publisher-id, хвост DOI) → заголовок в тексте PDF.
   Ручной выбор и уже отправленные статьи не трогаются. */
function pairJats() {
  const used = new Set(B.rows.filter((r) => pairLocked(r) && r.pdf).map((r) => r.pdf.name));
  const open = B.rows.filter((r) => !pairLocked(r));
  open.forEach((r) => (r.pdf = null));
  const take = (r, p) => { r.pdf = p; used.add(p.name); };
  const free = () => B.pdfs.filter((p) => !used.has(p.name));
  // 1. DOI в тексте
  for (const r of open) {
    const p = free().find((x) => pdfHasDoi(pdfMeta.get(x.name), r.info?.doi));
    if (p) take(r, p);
  }
  // 2. имя файла — только для PDF, у которых в тексте нет DOI другой статьи
  const foreignByText = (p) => B.rows.some((x) => pdfHasDoi(pdfMeta.get(p.name), x.info?.doi));
  for (const r of open.filter((x) => !x.pdf)) {
    const keys = [baseName(r.xml.name), (r.info.pid || "").toLowerCase()].filter(Boolean);
    const tail = doiTail(r.info.doi);
    const cand = free().filter((p) => !foreignByText(p));
    const p = cand.find((x) => keys.includes(baseName(x.name)))
      || (tail.length > 5 ? cand.find((x) => baseName(x.name).includes(tail)) : null);
    if (p) take(r, p);
  }
  // 3. заголовок в тексте
  for (const r of open.filter((x) => !x.pdf)) {
    const p = free().find((x) => !foreignByText(x) && pdfHasTitle(pdfMeta.get(x.name), r.info?.title));
    if (p) take(r, p);
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
    ? "Выберите сразу все JATS XML и PDF номера. Пары подбираются по DOI на первой странице PDF, затем по имени файла (719667.xml ↔ 719667.pdf) и по заголовку. Нажмите на статью, чтобы сверить её с PDF в панели справа."
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
  // сверка по тексту PDF
  const reading = B.pdfs.filter((p) => pdfMeta.get(p.name)?.state === "reading" || !pdfMeta.has(p.name)).length;
  if (B.pdfs.length && reading) parts.push(`<span class="badge b-run"><span class="dot"></span>читаю PDF <b>${B.pdfs.length - reading}/${B.pdfs.length}</b></span>`);
  if (B.rows.length) {
    const v = B.rows.map(verifyRow).filter(Boolean);
    const ok = v.filter((x) => x.k === "doi" || x.k === "title").length;
    const bad = v.filter((x) => x.k === "other" || x.k === "foreign").length;
    const unk = v.filter((x) => x.k === "unknown" || x.k === "error").length;
    if (ok) parts.push(`<span class="badge b-ok"><span class="dot"></span>сверено по PDF <b>${ok}</b></span>`);
    if (bad) parts.push(`<span class="badge b-bad"><span class="dot"></span>PDF не от той статьи <b>${bad}</b></span>`);
    if (unk) parts.push(`<span class="badge b-warn"><span class="dot"></span>не удалось сверить <b>${unk}</b></span>`);
  }
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
      const cls = [["error", "failed", "invalid"].includes(r.state) ? "row-err" : "", V.row === i ? "sel" : ""].join(" ");
      return `<tr class="${cls}" data-i="${i}">
        <td class="num">${i + 1}</td>
        <td><button type="button" class="t t-btn" data-view="${i}" title="Открыть в просмотре">${esc((r.info?.title || "").slice(0, 140) || "—")}</button>
          <div class="sub-m">${esc(r.info?.doi || "без DOI")}${r.xml ? " · " + esc(r.xml.name) : ""}</div></td>
        <td class="num">${esc(r.info?.pages || "—")}</td>
        <td>${pdfSelect(r, i)}
          <div class="pdf-tools">${verifyHtml(r, B.rows)}<button type="button" class="link" data-view="${i}">смотреть</button></div></td>
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
  const wrong = queue.filter((r) => ["other", "foreign"].includes(verifyRow(r)?.k));
  if (wrong.length && !confirm(`У ${wrong.length} ${plural(wrong.length, "статьи", "статей", "статей")} PDF, судя по DOI в тексте, от другой статьи: №${wrong.map((r) => B.rows.indexOf(r) + 1).join(", ")}.\n\nПроверьте их в просмотре («смотреть»). Всё равно загрузить?`)) return;
  const noPdf = queue.filter((r) => !r.pdf).length;
  if (noPdf && !confirm(`${noPdf} ${plural(noPdf, "статья уйдёт", "статьи уйдут", "статей уйдут")} без PDF. PDF можно будет догрузить позже. Продолжить?`)) return;
  B.running = true; B.stop = false; renderBatch();
  for (const r of queue) {
    if (B.stop) { r.state = "stopped"; continue; }
    r.state = "uploading"; r.msg = ""; r.msgInfo = false; renderBatch(); renderViewer();
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
  const locked = (r) => r.pdfManual || r.pdfDone || r.state === "signed";
  const used = new Set(B.rows.filter((r) => locked(r) && r.pdf).map((r) => r.pdf.name));
  const open = B.rows.filter((r) => !locked(r));
  open.forEach((r) => (r.pdf = null));
  const free = () => B.pdfs.filter((p) => !used.has(p.name));
  const take = (r, p) => { r.pdf = p; used.add(p.name); };
  for (const r of open) {
    const p = free().find((x) => pdfHasDoi(pdfMeta.get(x.name), r.info?.doi));
    if (p) take(r, p);
  }
  const foreignByText = (p) => B.rows.some((x) => pdfHasDoi(pdfMeta.get(p.name), x.info?.doi));
  for (const r of open.filter((x) => !x.pdf)) {
    const cand = free().filter((p) => !foreignByText(p));
    const tail = doiTail(r.info.doi);
    const pages = r.info.pages;
    const p = (tail.length > 5 && cand.find((x) => baseName(x.name).includes(tail)))
      || (pages && cand.find((x) => new RegExp(`(^|[^0-9])${pages.replace("-", "[-–_]")}([^0-9]|$)`).test(baseName(x.name))))
      || cand.find((x) => pdfHasTitle(pdfMeta.get(x.name), r.info?.title));
    if (p) take(r, p);
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

/* =========================================================
   Панель просмотра: PDF выбранной статьи справа от таблицы,
   сверху — данные статьи из XML и результат сверки.
   PDF показывает встроенный просмотрщик браузера.
   ========================================================= */
const V = { row: null, shown: null };

function openViewer(i) {
  if (!B.rows[i]) return;
  V.row = i;
  document.body.classList.add("viewer-open");
  $("#viewer").hidden = false;
  renderViewer();
  renderBatch();
  $(`#bTable tr[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}
function closeViewer() {
  V.row = null; V.shown = null; V.task++;
  document.body.classList.remove("viewer-open");
  $("#viewer").hidden = true;
  $("#vDoc").innerHTML = "";
  renderBatch();
}
function stepViewer(d) {
  if (V.row == null || !B.rows.length) return;
  openViewer((V.row + d + B.rows.length) % B.rows.length);
}
function nextProblem() {
  const n = B.rows.length;
  for (let k = 1; k <= n; k++) {
    const i = ((V.row ?? -1) + k) % n;
    const r = B.rows[i];
    const v = verifyRow(r);
    if (!r.pdf || (v && !["doi", "title"].includes(v.k))) return openViewer(i);
  }
  $("#vHint").textContent = "Проблемных пар не осталось.";
}

function renderViewer() {
  if (V.row == null || $("#viewer").hidden) return;
  if (!B.rows[V.row]) return closeViewer();
  const r = B.rows[V.row], i = V.row, n = B.rows.length;
  const v = verifyRow(r);
  const info = r.info || {};
  $("#vPos").textContent = `СВЕРКА · СТАТЬЯ ${i + 1} ИЗ ${n}`;

  // кто ещё претендует: PDF, в тексте которого DOI этой статьи
  const ownPdf = B.pdfs.find((p) => p !== r.pdf && pdfHasDoi(pdfMeta.get(p.name), info.doi));
  const ownHolder = ownPdf ? B.rows.find((x) => x.pdf === ownPdf) : null;
  let fix = "";
  if (v?.k === "other") {
    fix += `<button type="button" class="btn btn-ghost btn-sm" data-fix="give">Отдать этот PDF статье #${B.rows.indexOf(v.other) + 1}${ownPdf && v.other.pdf === ownPdf ? " (обмен)" : ""}</button>`;
  }
  if (ownPdf && !(v?.k === "other" && v.other.pdf === ownPdf)) {
    fix += `<button type="button" class="btn btn-ghost btn-sm" data-fix="take" data-pdf="${esc(ownPdf.name)}">Взять ${esc(ownPdf.name)}${ownHolder ? ` (сейчас у #${B.rows.indexOf(ownHolder) + 1})` : ""}</button>`;
  }
  const locked = $(`#bTable select[data-row="${i}"]`)?.disabled;

  $("#vMeta").innerHTML = `
    <div class="v-title">${esc(info.title || "—")}</div>
    <dl class="kv v-kv">
      <dt>DOI</dt><dd>${esc(info.doi || "—")}</dd>
      <dt>Страницы</dt><dd>${esc(info.pages || "—")}${pdfMeta.get(r.pdf?.name)?.pages ? ` <span class="muted">· в PDF ${pdfMeta.get(r.pdf.name).pages} стр.</span>` : ""}</dd>
      ${info.authors ? `<dt>Авторы</dt><dd class="sans">${esc(info.authors)}</dd>` : ""}
      ${r.xml ? `<dt>XML</dt><dd>${esc(r.xml.name)}</dd>` : ""}
    </dl>
    ${r.pdf ? verifyHtml(r, B.rows) : '<div class="verify v-warn">у статьи нет PDF</div>'}
    ${fix && !locked ? `<div class="actions">${fix}</div>` : ""}`;

  const sel = $("#vSelect");
  sel.disabled = !!locked;
  sel.innerHTML = [`<option value="">— без PDF —</option>`].concat(B.pdfs.map((p, k) => {
    const mark = pdfHasDoi(pdfMeta.get(p.name), info.doi) ? "✓ " : "";
    const holder = B.rows.find((x) => x !== r && x.pdf === p);
    return `<option value="${k}" ${r.pdf === p ? "selected" : ""}>${mark}${esc(p.name)}${holder ? `  · у #${B.rows.indexOf(holder) + 1}` : ""}</option>`;
  })).join("");

  // PDF перерисовываем, только если сменился файл
  if (V.shown !== r.pdf) {
    V.shown = r.pdf;
    if (r.pdf) {
      $("#vOpen").href = pdfUrl(r.pdf); $("#vOpen").hidden = false;
      showPdf(r.pdf);
    } else {
      V.task++;
      $("#vDoc").innerHTML = '<div class="v-empty">У этой статьи нет PDF.<br>Выберите файл в списке выше.</div>';
      $("#vOpen").hidden = true;
    }
  }
  $("#vHint").textContent = "";
}

/* Страницы PDF рисуются PDF.js на canvas по ширине панели — одинаково
   во всех браузерах, включая телефоны. Если PDF.js недоступен —
   встроенный просмотрщик браузера в iframe. */
V.task = 0;
async function showPdf(file) {
  const my = ++V.task;
  const box = $("#vDoc");
  box.innerHTML = '<div class="v-pages"><div class="v-empty">Открываю PDF…</div></div>';
  let doc;
  try {
    const lib = await loadPdfJs();
    doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch {
    if (my === V.task) box.innerHTML = `<iframe title="PDF ${esc(file.name)}" src="${pdfUrl(file)}#view=FitH"></iframe>`;
    return;
  }
  if (my !== V.task) { doc.destroy(); return; }
  const wrap = box.firstElementChild;
  wrap.innerHTML = "";
  try {
    for (let i = 1; i <= doc.numPages && my === V.task; i++) {
      const page = await doc.getPage(i);
      const width = Math.max(200, wrap.clientWidth - 24 - 2 - 2); // поля + рамка + запас
      const base = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const fig = document.createElement("figure");
      fig.className = "v-page";
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = Math.floor(vp.width / dpr) + "px";
      c.style.height = Math.floor(vp.height / dpr) + "px";
      fig.appendChild(c);
      fig.insertAdjacentHTML("beforeend", `<figcaption>стр. ${i} из ${doc.numPages}</figcaption>`);
      wrap.appendChild(fig);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    }
  } finally { doc.destroy(); }
}
let vResize = null;
window.addEventListener("resize", () => {
  clearTimeout(vResize);
  vResize = setTimeout(() => { if (V.shown && !$("#viewer").hidden) showPdf(V.shown); }, 250);
});

function setRowPdf(r, pdf) {
  r.pdf = pdf || null;
  r.pdfManual = true;
  renderBatch(); renderViewer();
}
$("#vSelect").addEventListener("change", (e) => {
  const r = B.rows[V.row]; if (!r) return;
  setRowPdf(r, e.target.value === "" ? null : B.pdfs[+e.target.value]);
});
$("#vMeta").addEventListener("click", (e) => {
  const b = e.target.closest("[data-fix]"); if (!b) return;
  const r = B.rows[V.row];
  if (b.dataset.fix === "give") {
    const other = verifyRow(r)?.other; if (!other) return;
    const mine = r.pdf, theirs = other.pdf;
    other.pdf = mine; other.pdfManual = true;
    // обмен, если у той статьи как раз PDF этой
    r.pdf = theirs && pdfHasDoi(pdfMeta.get(theirs.name), r.info?.doi) ? theirs : null;
    r.pdfManual = true;
  } else {
    const p = B.pdfs.find((x) => x.name === b.dataset.pdf); if (!p) return;
    const holder = B.rows.find((x) => x !== r && x.pdf === p);
    if (holder) { holder.pdf = null; holder.pdfManual = true; }
    r.pdf = p; r.pdfManual = true;
  }
  renderBatch(); renderViewer();
});
$("#vClose").addEventListener("click", closeViewer);
$("#vPrev").addEventListener("click", () => stepViewer(-1));
$("#vNext").addEventListener("click", () => stepViewer(1));
$("#vNextIssue").addEventListener("click", nextProblem);
document.addEventListener("keydown", (e) => {
  if ($("#viewer").hidden || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowRight") { e.preventDefault(); stepViewer(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepViewer(-1); }
});
// на другой вкладке консоли панель не нужна
$$(".tab").forEach((t) => t.addEventListener("click", () => { if (t.dataset.tab !== "batch" && V.row != null) closeViewer(); }));

/* ---------- события ---------- */
function resetBatch() {
  if (V.row != null) closeViewer();
  pdfUrls.forEach((u) => URL.revokeObjectURL(u.url)); pdfUrls.clear();
  pdfMeta.clear();
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
  renderBatch(); renderViewer();
});
$("#bTable").addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]"); if (b) openViewer(+b.dataset.view);
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
