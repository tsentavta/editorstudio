"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kb = (n) => (n < 1024 * 1024 ? (n / 1024).toFixed(1) + " КБ" : (n / 1048576).toFixed(2) + " МБ");
const fmtDate = (s) => { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? s : d.toLocaleString("ru-RU"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATUS = { 1: ["Загружен", "b-run"], 2: ["Обрабатывается", "b-run"], 3: ["Обработан", "b-ok"], 4: ["Ошибка обработки", "b-bad"] };

/* =========================================================
   Хранилище (только удобство: история загрузок в браузере)
   ========================================================= */
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
let history = store.get("metafora.history", []);
function saveHistory() { store.set("metafora.history", history.slice(0, 200)); renderHistory(); }
function addHistory(rec) {
  history = history.filter((h) => h.file_uid !== rec.file_uid);
  history.unshift(rec);
  saveHistory();
}
function patchHistory(uid, patch) {
  const h = history.find((x) => x.file_uid === uid);
  if (h) { Object.assign(h, patch); saveHistory(); }
}

/* =========================================================
   Вызов API через локальный прокси + журнал
   ========================================================= */
const log = [];
let seq = 0;

async function call(method, path, { query, json, form, silent } = {}) {
  let url = path;
  if (query) url += "?" + new URLSearchParams(query).toString();
  const opts = { method, headers: {} };
  let req = null;
  if (json) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
    req = json;
  } else if (form) {
    const fd = new FormData();
    req = {};
    for (const [k, v] of Object.entries(form)) {
      if (v == null || v === "") continue;
      fd.append(k, v);
      req[k] = v instanceof File ? `@${v.name} (${kb(v.size)})` : v;
    }
    opts.body = fd;
  }
  const t0 = performance.now();
  let status = 0, data = null, text = "";
  try {
    const r = await fetch(url, opts);
    status = r.status;
    text = await r.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  } catch (e) {
    data = { message: "Нет связи с локальным сервером: " + e.message, error: "LOCAL_NETWORK" };
  }
  const entry = { id: ++seq, method, url, status, ms: Math.round(performance.now() - t0), req, data, at: new Date() };
  if (!silent) pushLog(entry);
  return { ok: status >= 200 && status < 300, status, data, entry };
}

function pushLog(entry) {
  log.unshift(entry);
  if (log.length > 100) log.pop();
  showEntry(entry);
  renderLog();
}

function statusClass(s) { return s >= 200 && s < 300 ? "t-ok" : s >= 400 && s < 500 ? "t-warn" : "t-err"; }

function highlight(value) {
  if (value == null) return '<span class="t-dim">// пустой ответ</span>';
  if (typeof value === "string") return esc(value);
  const json = JSON.stringify(value, null, 2);
  return esc(json).replace(
    /(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|(?!&quot;)[^\\])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g,
    (m, str, colon, bool, num, pun) => {
      if (str) return colon ? `<span class="t-key">${str}</span><span class="t-pun">${colon}</span>` : `<span class="t-str">${str}</span>`;
      if (bool) return `<span class="t-bool">${bool}</span>`;
      if (num) return `<span class="t-num">${num}</span>`;
      return `<span class="t-pun">${pun}</span>`;
    }
  );
}

let shown = null;
function showEntry(e) {
  shown = e;
  $("#termLine").innerHTML =
    `<span class="t-m">${esc(e.method)}</span> ${esc(e.url)}<br>` +
    `<span class="${statusClass(e.status)}">${e.status || "ERR"}</span> <span class="t-dim">· ${e.ms} мс · ${e.at.toLocaleTimeString("ru-RU")}</span>`;
  let body = "";
  if (e.req) body += `<span class="t-dim">// запрос</span>\n${highlight(e.req)}\n\n<span class="t-dim">// ответ</span>\n`;
  body += e.status === 204 ? '<span class="t-dim">// 204 No Content — выполнено</span>' : highlight(e.data);
  $("#termBody").innerHTML = body;
  $("#termBody").scrollTop = 0;
  $$("#termLog li").forEach((li) => li.classList.toggle("sel", +li.dataset.id === e.id));
}

function renderLog() {
  $("#termLog").innerHTML = log.map((e) =>
    `<li data-id="${e.id}" class="${shown && shown.id === e.id ? "sel" : ""}">
      <span class="t-m">${esc(e.method)}</span>
      <span class="${statusClass(e.status)}">${e.status || "ERR"}</span>
      <span class="p">${esc(e.url.replace("/api/v2", ""))}</span>
      <span class="t-dim">${e.ms}мс</span></li>`).join("");
}
$("#termLog").addEventListener("click", (ev) => {
  const li = ev.target.closest("li"); if (!li) return;
  const e = log.find((x) => x.id === +li.dataset.id); if (e) showEntry(e);
});
$("#copyBtn").addEventListener("click", async () => {
  if (!shown) return;
  const txt = typeof shown.data === "string" ? shown.data : JSON.stringify(shown.data, null, 2);
  try { await navigator.clipboard.writeText(txt ?? ""); $("#copyBtn").textContent = "скопировано"; }
  catch { $("#copyBtn").textContent = "не удалось"; }
  setTimeout(() => ($("#copyBtn").textContent = "копировать"), 1400);
});

/* =========================================================
   Сообщения об ошибках
   ========================================================= */
function errorHtml(res) {
  const d = res.data && typeof res.data === "object" ? res.data : { message: String(res.data || "") };
  let h = `<b>${esc(d.message || "Ошибка")}</b><span class="code-tag">HTTP ${res.status}${d.error ? " · " + esc(d.error) : ""}</span>`;
  if (d.errors && typeof d.errors === "object") {
    h += "<ul>" + Object.entries(d.errors).map(([k, v]) => `<li><span class="mono">${esc(k)}</span>: ${esc([].concat(v).join("; "))}</li>`).join("") + "</ul>";
  }
  const inner = d.data || {};
  if (Array.isArray(inner.errors)) h += "<ul>" + inner.errors.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>";
  const desc = inner.description || d.description;
  if (desc) h += `<pre>${esc(desc)}</pre>`;
  if (inner.exists_file_uid) h += `<div style="margin-top:8px">Уже загружен как <button class="link" data-open-file="${esc(inner.exists_file_uid)}">${esc(inner.exists_file_uid)}</button></div>`;
  return `<div class="note err">${h}</div>`;
}
const okHtml = (msg) => `<div class="note ok"><b>${msg}</b></div>`;

function busy(btn, on) { btn.disabled = on; btn.classList.toggle("is-busy", on); }

/* =========================================================
   Вкладки
   ========================================================= */
const HERO = {
  upload: ["Загрузка статей в <em>Метафору</em>", "JATS или Journal XML, PDF к статьям, статус обработки и подписание — через официальный API. Ключ хранится на локальном сервере и в браузер не передаётся."],
  files: ["Статус и <em>файлы</em>", "Проверка обработки XML, догрузка PDF и удаление файла вместе с его публикациями."],
  pubs: ["Публикации и <em>подписание</em>", "Полные метаданные статьи, PDF к конкретной публикации, подписание и отзыв подписи."],
  search: ["Поиск по <em>DOI</em> и EDN", "Найти публикацию своей организации — или по всей системе с флагом public."],
};
function setTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== name));
  $("#heroTitle").innerHTML = HERO[name][0];
  $("#heroLead").textContent = HERO[name][1];
}
$$("[data-tab]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); setTab(b.dataset.tab); }));

document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-open-file]");
  if (f) { setTab("files"); $("#fileUid").value = f.dataset.openFile; loadFile(f.dataset.openFile); return; }
  const a = e.target.closest("[data-open-art]");
  if (a) { setTab("pubs"); $("#artUid").value = a.dataset.openArt; loadPub(a.dataset.openArt); }
});

/* =========================================================
   Ключ и проверка связи
   ========================================================= */
async function initConfig() {
  try {
    const c = await (await fetch("/local/config")).json();
    $("#keyText").textContent = c.hasKey ? "ключ задан" : "нет ключа";
    $("#keyBadge").classList.toggle("bad", !c.hasKey);
  } catch {
    $("#keyText").textContent = "сервер недоступен";
    $("#keyBadge").classList.add("bad");
  }
}
$("#pingBtn").addEventListener("click", async () => {
  const b = $("#pingBtn"); busy(b, true);
  // Заведомо несуществующий file_uid: 404 = ключ принят, 401/403 = проблема с ключом.
  const r = await call("GET", "/api/v2/files/status/", { query: { file_uid: "00000000-0000-0000-0000-000000000000" } });
  busy(b, false);
  const good = r.status === 404 || r.ok;
  $("#keyBadge").classList.toggle("ok", good);
  $("#keyBadge").classList.toggle("bad", !good);
  $("#keyText").textContent = good ? "ключ работает" : r.status === 401 ? "ключ неактивен" : r.status === 403 ? "ключ отклонён" : "нет связи";
});

/* =========================================================
   Загрузка
   ========================================================= */
const MODES = {
  journal: { path: "/api/v2/files/journal/", pdf: false, hint: "Формат РИНЦ (journal3.xsd): XML выпуска целиком. PDF добавляется после обработки — к файлу или к каждой статье." },
  jats: { path: "/api/v2/files/jats/xml/", pdf: false, hint: "JATS 1.4 Archiving (OASIS). Корень — <article>. PDF можно догрузить позже." },
  jats_pdf: { path: "/api/v2/files/jats/xml_pdf/", pdf: true, hint: "JATS XML и PDF статьи одним запросом." },
};
let mode = store.get("metafora.mode", "journal");
if (!MODES[mode]) mode = "journal";

function setMode(m) {
  mode = m; store.set("metafora.mode", m);
  $$("#modeSeg .seg-btn").forEach((b) => b.classList.toggle("is-on", b.dataset.mode === m));
  $("#dropPdf").hidden = !MODES[m].pdf;
  $("#modeHint").textContent = MODES[m].hint;
}
$$("#modeSeg .seg-btn").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

function wireDrop(drop, input) {
  const name = $(".drop-name", drop);
  const upd = () => {
    const f = input.files[0];
    drop.classList.toggle("has-file", !!f);
    name.textContent = f ? `${f.name} · ${kb(f.size)}` : name.dataset.empty;
  };
  input.addEventListener("change", upd);
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("is-over")));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; upd(); }
  });
  return upd;
}
const updXml = wireDrop($("#dropXml"), $("#fXml"));
const updPdf = wireDrop($("#dropPdf"), $("#fPdf"));

$("#resetBtn").addEventListener("click", () => {
  $("#fXml").value = ""; $("#fPdf").value = ""; $("#platform").value = "";
  updXml(); updPdf(); $("#uploadNote").hidden = true;
});

$("#uploadBtn").addEventListener("click", async () => {
  const note = $("#uploadNote");
  const xml = $("#fXml").files[0], pdf = $("#fPdf").files[0];
  const m = MODES[mode];
  if (!xml || (m.pdf && !pdf)) {
    note.hidden = false;
    note.className = "note err";
    note.innerHTML = `<b>Выберите ${!xml ? "XML-файл" : "PDF-файл"}</b>`;
    return;
  }
  const btn = $("#uploadBtn"); busy(btn, true); note.hidden = true;
  const form = { xml, platform: $("#platform").value.trim() };
  if (m.pdf) form.pdf = pdf;
  const r = await call("POST", m.path, { form });
  busy(btn, false);
  note.hidden = false;
  if (r.ok && r.data?.data?.file_uid) {
    const uid = r.data.data.file_uid;
    note.className = "note ok";
    note.innerHTML = `<b>Принято к обработке</b><span class="code-tag">file_uid ${esc(uid)}</span>`;
    addHistory({ file_uid: uid, name: xml.name, mode, at: new Date().toISOString(), code: r.data.data.xml?.status?.code || 1, pdf: !!m.pdf });
    pollUpload(uid);
  } else {
    note.className = "";
    note.innerHTML = errorHtml(r);
  }
});

let pollToken = 0;
function paintSteps(code) {
  $$("#procSteps li").forEach((li) => {
    const c = +li.dataset.code;
    li.className = code === 4 ? (c === 3 ? "fail" : "done") : c < code || code === 3 ? "done" : c === code ? "now" : "";
  });
  const last = $("#procSteps li[data-code='3']");
  last.textContent = code === 4 ? "Ошибка" : "Обработан";
}
async function pollUpload(uid) {
  const my = ++pollToken;
  $("#procCard").hidden = false;
  $("#procUid").textContent = uid;
  $("#procOpen").dataset.openFile = uid;
  $("#procBody").innerHTML = '<p class="hint">Проверяем статус каждые 3 секунды…</p>';
  paintSteps(1);
  let lastCode = null;
  for (let i = 0; i < 100 && my === pollToken; i++) {
    const r = await call("GET", "/api/v2/files/status/", { query: { file_uid: uid }, silent: true });
    if (my !== pollToken) return;
    if (!r.ok) { pushLog(r.entry); $("#procBody").innerHTML = errorHtml(r); return; }
    const d = r.data.data || {};
    const code = d.xml?.status?.code;
    if (code !== lastCode) { pushLog(r.entry); lastCode = code; }
    paintSteps(code);
    patchHistory(uid, { code, pdf: !!d.pdf?.status?.uploaded, articles: d.articles || [] });
    if (code === 3 || code === 4) { $("#procBody").innerHTML = fileDetailsHtml(uid, d); wireFileActions($("#procBody"), uid); return; }
    await sleep(3000);
  }
  if (my === pollToken) $("#procBody").innerHTML = '<p class="hint">Обработка идёт дольше обычного. Проверьте статус позже во вкладке «Файлы».</p>';
}

/* =========================================================
   Файлы
   ========================================================= */
function statusBadge(code) {
  const [t, c] = STATUS[code] || ["Неизвестно", ""];
  return `<span class="badge ${c}"><span class="dot"></span>${t}</span>`;
}
function fileDetailsHtml(uid, d) {
  const code = d.xml?.status?.code;
  const arts = d.articles || [];
  const pdf = !!d.pdf?.status?.uploaded;
  let h = `<dl class="kv">
    <dt>Статус XML</dt><dd>${statusBadge(code)} <span class="t-dim mono" style="color:var(--stone)">code ${esc(code)}</span></dd>
    <dt>PDF</dt><dd class="sans">${pdf ? "загружен" : "нет"}</dd>
    <dt>Статей</dt><dd>${arts.length}</dd></dl>`;
  if (arts.length) {
    h += `<ul class="uids">${arts.map((a) => `<li><span class="mono">${esc(a)}</span><button class="link" data-open-art="${esc(a)}">открыть →</button></li>`).join("")}</ul>`;
  }
  h += `<div class="sub">
    <div class="eyebrow">PDF К ФАЙЛУ ${arts.length > 1 ? '<span class="muted">· в файле несколько статей — PDF загружайте к каждой публикации</span>' : ""}</div>
    <div class="pdf-up">
      <span class="btn btn-ghost btn-sm file-btn">Выбрать PDF<input type="file" accept=".pdf,application/pdf" data-role="pdf"></span>
      <span class="fname" data-role="fname">файл не выбран</span>
      <button class="btn btn-ghost btn-sm" data-role="pdfgo" ${pdf ? "disabled" : ""}>Загрузить PDF</button>
    </div>
    <div class="actions"><button class="btn btn-ghost btn-sm btn-danger" data-role="del">Удалить файл и публикации</button></div>
    <div data-role="msg"></div>
  </div>`;
  return h;
}
function wireFileActions(root, uid) {
  const inp = $("[data-role=pdf]", root), fname = $("[data-role=fname]", root), msg = $("[data-role=msg]", root);
  inp.addEventListener("change", () => (fname.textContent = inp.files[0] ? `${inp.files[0].name} · ${kb(inp.files[0].size)}` : "файл не выбран"));
  $("[data-role=pdfgo]", root).addEventListener("click", async (e) => {
    if (!inp.files[0]) { msg.innerHTML = '<div class="note err"><b>Выберите PDF</b></div>'; return; }
    busy(e.currentTarget, true);
    const r = await call("POST", "/api/v2/files/pdf/", { query: { file_uid: uid }, form: { pdf: inp.files[0] } });
    busy(e.currentTarget, false);
    msg.innerHTML = r.ok ? okHtml("PDF загружен") : errorHtml(r);
    if (r.ok) patchHistory(uid, { pdf: true });
  });
  $("[data-role=del]", root).addEventListener("click", async (e) => {
    if (!confirm(`Удалить файл ${uid} и все созданные из него публикации?\n\nДействие необратимо. Файлы с подписанными публикациями удалить нельзя.`)) return;
    busy(e.currentTarget, true);
    const r = await call("DELETE", `/api/v2/files/${encodeURIComponent(uid)}`);
    busy(e.currentTarget, false);
    if (r.ok) {
      history = history.filter((h) => h.file_uid !== uid); saveHistory();
      root.innerHTML = okHtml("Файл удалён");
    } else msg.innerHTML = errorHtml(r);
  });
}
async function loadFile(uid) {
  uid = (uid || "").trim();
  const out = $("#fileResult");
  if (!uid) { out.innerHTML = '<div class="note err"><b>Укажите file_uid</b></div>'; return; }
  const b = $("#statusBtn"); busy(b, true);
  const r = await call("GET", "/api/v2/files/status/", { query: { file_uid: uid } });
  busy(b, false);
  if (!r.ok) { out.innerHTML = errorHtml(r); return; }
  const d = r.data.data || {};
  patchHistory(uid, { code: d.xml?.status?.code, pdf: !!d.pdf?.status?.uploaded, articles: d.articles || [] });
  out.innerHTML = `<div class="sub" style="border:0;padding:0">${fileDetailsHtml(uid, d)}</div>`;
  wireFileActions(out, uid);
}
$("#statusBtn").addEventListener("click", () => loadFile($("#fileUid").value));
$("#fileUid").addEventListener("keydown", (e) => e.key === "Enter" && loadFile($("#fileUid").value));

const MODE_LABEL = { journal: "Journal", jats: "JATS", jats_pdf: "JATS+PDF" };
function renderHistory() {
  $("#uidList").innerHTML = history.map((h) => `<option value="${esc(h.file_uid)}">${esc(h.name)}</option>`).join("");
  if (!history.length) { $("#history").innerHTML = '<div class="empty">Пока пусто. Загруженные файлы появятся здесь.</div>'; return; }
  $("#history").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Файл</th><th>Формат</th><th>Статус</th><th>Статей</th><th>Загружен</th></tr></thead>
    <tbody>${history.map((h) => `<tr>
      <td><button class="link" data-open-file="${esc(h.file_uid)}">${esc(h.name)}</button><div class="mono" style="font-size:11px;color:var(--stone);word-break:break-all">${esc(h.file_uid)}</div></td>
      <td class="mono">${esc(MODE_LABEL[h.mode] || h.mode)}</td>
      <td>${h.code ? statusBadge(h.code) : "—"}</td>
      <td class="mono">${h.articles ? h.articles.length : "—"}</td>
      <td style="white-space:nowrap;color:var(--slate)">${fmtDate(h.at)}</td></tr>`).join("")}</tbody></table></div>`;
}
$("#histClear").addEventListener("click", () => {
  if (history.length && confirm("Очистить локальную историю загрузок? Файлы в «Метафоре» не затрагиваются.")) { history = []; saveHistory(); }
});

/* =========================================================
   Публикации
   ========================================================= */
let pubLocale = null;
function pages(l) { return l.fpage ? (l.lpage && l.lpage !== l.fpage ? `${l.fpage}–${l.lpage}` : `${l.fpage}`) : l.elocation_id || "—"; }

function pubHtml(uid, article, sig) {
  const locales = Object.keys(article || {});
  if (!locales.length) return '<div class="note">Публикация без данных</div>';
  if (!pubLocale || !article[pubLocale]) pubLocale = locales.includes("RUS") ? "RUS" : locales[0];
  const l = article[pubLocale];
  const signed = sig && sig.signed_at;
  const sigBadge = signed
    ? `<span class="badge b-ok"><span class="dot"></span>подписана ${fmtDate(sig.signed_at)}</span>`
    : `<span class="badge"><span class="dot"></span>не подписана${sig && sig.unsigned_at ? " · отозвана " + fmtDate(sig.unsigned_at) : ""}</span>`;

  const authors = (l.authors || []).map((a) => {
    const aff = (a.aff || []).map((x) => x.institution || x.aff || x.institution_wrap).filter(Boolean).join("; ");
    const ids = [a.orcid && "ORCID " + a.orcid, a.spin && "SPIN " + a.spin, a.scopusid && "Scopus " + a.scopusid].filter(Boolean).join(" · ");
    return `<li><b>${esc([a.surname, a.given_names].filter(Boolean).join(" "))}</b>${aff ? `<span class="aff">${esc(aff)}</span>` : ""}${ids ? `<span class="ids">${esc(ids)}</span>` : ""}</li>`;
  }).join("");
  const kw = (l.keywords || []).map((k) => `<span class="chip">${esc(k.value)}</span>`).join("");
  const refs = (l.references || []).map((r) => `<li>${esc(r.text)}</li>`).join("");
  const fund = (l.funding || []).map((f) => f.info).filter(Boolean);

  return `
  <div class="sub" style="border:0;padding:0">
    <div class="card-head">
      <div class="seg">${locales.map((k) => `<button class="seg-btn ${k === pubLocale ? "is-on" : ""}" data-loc="${esc(k)}">${esc(k)}</button>`).join("")}</div>
      ${sigBadge}
    </div>
    <h2 class="pub-title">${esc(l.title || "Без названия")}</h2>
    <dl class="kv">
      <dt>article_uid</dt><dd>${esc(uid)}</dd>
      <dt>DOI</dt><dd>${esc(l.doi || "—")}</dd>
      <dt>EDN</dt><dd>${esc(l.edn || "—")}</dd>
      <dt>Год · том · №</dt><dd>${esc([l.year, l.volume, l.issue].map((x) => x ?? "—").join(" · "))}</dd>
      <dt>Страницы</dt><dd>${esc(pages(l))}</dd>
      <dt>Тип</dt><dd class="sans">${esc(l.pub_type || "—")}</dd>
      <dt>УДК</dt><dd>${esc((l.udk || []).join(", ") || "—")}</dd>
      <dt>Даты</dt><dd class="sans">поступила ${esc(l.date_received || "—")} · принята ${esc(l.date_accepted || "—")} · опубл. ${esc(l.date_publication || "—")}</dd>
      <dt>Обновлено</dt><dd class="sans">${fmtDate(l.updated_at)}</dd>
    </dl>
    ${authors ? `<div class="eyebrow">АВТОРЫ</div><ul class="authors">${authors}</ul>` : ""}
    ${l.abstract ? `<div class="eyebrow">АННОТАЦИЯ</div><p class="abstract">${esc(l.abstract)}</p>` : ""}
    ${kw ? `<div class="eyebrow">КЛЮЧЕВЫЕ СЛОВА</div><div class="chips">${kw}</div>` : ""}
    ${fund.length ? `<div class="eyebrow">ФИНАНСИРОВАНИЕ</div><p class="abstract">${esc(fund.join(" "))}</p>` : ""}
    ${refs ? `<details class="acc"><summary>Список литературы · ${(l.references || []).length}</summary><ol>${refs}</ol></details>` : ""}

    <div class="sub">
      <div class="eyebrow">PDF ПУБЛИКАЦИИ</div>
      <div class="pdf-up">
        <span class="btn btn-ghost btn-sm file-btn">Выбрать PDF<input type="file" accept=".pdf,application/pdf" data-role="ppdf"></span>
        <span class="fname" data-role="pfname">файл не выбран</span>
        <button class="btn btn-ghost btn-sm" data-role="ppdfgo" ${signed ? "disabled title='К подписанной публикации PDF не загружается'" : ""}>Загрузить PDF</button>
      </div>
      <div class="eyebrow">ПОДПИСАНИЕ</div>
      <div class="actions">
        ${signed
          ? `<button class="btn btn-ghost btn-danger" data-role="unsign">Отозвать подпись</button>`
          : `<button class="btn btn-primary" data-role="sign">Подписать публикацию</button><button class="btn btn-ghost" data-role="reload">Обновить</button>`}
      </div>
      <div data-role="pmsg"></div>
    </div>
  </div>`;
}

let pubCache = null;
async function loadPub(uid) {
  uid = (uid || "").trim();
  const out = $("#pubResult");
  if (!uid) { out.innerHTML = '<div class="note err"><b>Укажите article_uid</b></div>'; return; }
  const b = $("#artBtn"); busy(b, true);
  const r = await call("GET", `/api/v2/publications/${encodeURIComponent(uid)}`);
  if (!r.ok) { busy(b, false); out.innerHTML = errorHtml(r); return; }
  const s = await call("POST", "/api/v2/publications/status/batch", { json: { article_uids: [uid] }, silent: true });
  busy(b, false);
  showEntry(r.entry);
  const sig = s.ok && Array.isArray(s.data) ? s.data.find((x) => x.article_uid === uid) : null;
  const article = r.data?.article || r.data?.data?.article || {};
  pubCache = { uid, article, sig };
  pubLocale = null;
  renderPub();
}
function renderPub() {
  const { uid, article, sig } = pubCache;
  const out = $("#pubResult");
  out.innerHTML = pubHtml(uid, article, sig);
  $$("[data-loc]", out).forEach((b) => b.addEventListener("click", () => { pubLocale = b.dataset.loc; renderPub(); }));
  const msg = $("[data-role=pmsg]", out);
  const inp = $("[data-role=ppdf]", out), fn = $("[data-role=pfname]", out);
  inp.addEventListener("change", () => (fn.textContent = inp.files[0] ? `${inp.files[0].name} · ${kb(inp.files[0].size)}` : "файл не выбран"));
  $("[data-role=ppdfgo]", out).addEventListener("click", async (e) => {
    if (!inp.files[0]) { msg.innerHTML = '<div class="note err"><b>Выберите PDF</b></div>'; return; }
    busy(e.currentTarget, true);
    const r = await call("POST", `/api/v2/publications/${encodeURIComponent(uid)}/pdf/`, { form: { pdf: inp.files[0] } });
    busy(e.currentTarget, false);
    msg.innerHTML = r.ok ? okHtml("PDF загружен") : errorHtml(r);
  });
  const sign = $("[data-role=sign]", out), unsign = $("[data-role=unsign]", out), reload = $("[data-role=reload]", out);
  if (reload) reload.addEventListener("click", () => loadPub(uid));
  if (sign) sign.addEventListener("click", async () => {
    const title = (article.RUS || Object.values(article)[0] || {}).title || uid;
    if (!confirm(`Подписать публикацию?\n\n«${title}»\n\nПосле подписания PDF к ней загрузить нельзя, пока подпись не отозвана.`)) return;
    busy(sign, true);
    const r = await call("PUT", `/api/v2/publications/${encodeURIComponent(uid)}/sign/`);
    busy(sign, false);
    if (r.ok) { pubCache.sig = { article_uid: uid, signed_at: r.data?.data?.signed_at || new Date().toISOString() }; renderPub(); $("[data-role=pmsg]").innerHTML = okHtml("Публикация подписана"); }
    else msg.innerHTML = errorHtml(r);
  });
  if (unsign) unsign.addEventListener("click", async () => {
    if (!confirm("Отозвать подпись у публикации?")) return;
    busy(unsign, true);
    const r = await call("PUT", `/api/v2/publications/${encodeURIComponent(uid)}/unsign/`);
    busy(unsign, false);
    if (r.ok) { pubCache.sig = { article_uid: uid, signed_at: null, unsigned_at: new Date().toISOString() }; renderPub(); $("[data-role=pmsg]").innerHTML = okHtml("Подпись отозвана"); }
    else msg.innerHTML = errorHtml(r);
  });
}
$("#artBtn").addEventListener("click", () => loadPub($("#artUid").value));
$("#artUid").addEventListener("keydown", (e) => e.key === "Enter" && loadPub($("#artUid").value));

$("#batchBtn").addEventListener("click", async () => {
  const uids = [...new Set($("#batchUids").value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  const out = $("#batchResult");
  if (!uids.length) { out.innerHTML = '<div class="note err"><b>Добавьте хотя бы один article_uid</b></div>'; return; }
  if (uids.length > 100) { out.innerHTML = `<div class="note err"><b>Не больше 100 за запрос</b><span class="code-tag">сейчас ${uids.length}</span></div>`; return; }
  const b = $("#batchBtn"); busy(b, true);
  const r = await call("POST", "/api/v2/publications/status/batch", { json: { article_uids: uids } });
  busy(b, false);
  if (!r.ok) { out.innerHTML = errorHtml(r); return; }
  const rows = Array.isArray(r.data) ? r.data : [];
  const found = new Map(rows.map((x) => [x.article_uid, x]));
  out.innerHTML = `<div class="table-wrap"><table><thead><tr><th>article_uid</th><th>Подписана</th><th>Отозвана</th></tr></thead><tbody>${uids.map((u) => {
    const x = found.get(u);
    if (!x) return `<tr><td class="mono">${esc(u)}</td><td colspan="2" style="color:var(--stone)">не найдена или недоступна</td></tr>`;
    return `<tr><td class="mono"><button class="link mono" style="font-size:12px" data-open-art="${esc(u)}">${esc(u)}</button></td><td>${x.signed_at ? fmtDate(x.signed_at) : "—"}</td><td>${x.unsigned_at ? fmtDate(x.unsigned_at) : "—"}</td></tr>`;
  }).join("")}</tbody></table></div>`;
});

/* =========================================================
   Поиск
   ========================================================= */
let searchBy = "doi";
$$("#searchSeg .seg-btn").forEach((b) => b.addEventListener("click", () => {
  searchBy = b.dataset.by;
  $$("#searchSeg .seg-btn").forEach((x) => x.classList.toggle("is-on", x === b));
  $("#searchQ").placeholder = searchBy === "doi" ? "10.18469/1810-3189.2025.28.1.7-15" : "ABCDEF";
}));
async function doSearch() {
  let q = $("#searchQ").value.trim();
  const out = $("#searchResult");
  if (!q) { out.innerHTML = '<div class="note err"><b>Введите значение</b></div>'; return; }
  if (searchBy === "doi") q = q.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  const path = searchBy === "doi"
    ? "/api/v2/publications/doi/" + q.split("/").map(encodeURIComponent).join("/")
    : "/api/v2/publications/edn/" + encodeURIComponent(q);
  const b = $("#searchBtn"); busy(b, true);
  const r = await call("GET", path, { query: $("#searchPublic").checked ? { public: "true" } : undefined });
  busy(b, false);
  if (!r.ok) { out.innerHTML = errorHtml(r); return; }
  const d = r.data?.data || {};
  out.innerHTML = `<div class="sub"><dl class="kv">
    <dt>article_uid</dt><dd><button class="link mono" style="font-size:13px" data-open-art="${esc(d.article_uid)}">${esc(d.article_uid)} →</button></dd>
    <dt>Подписана</dt><dd class="sans">${d.signed_at ? fmtDate(d.signed_at) : "нет"}</dd>
    <dt>PDF</dt><dd class="sans">${d.has_pdf ? "есть" : "нет"}</dd>
    <dt>file_uid</dt><dd>${d.file_uid ? `<button class="link mono" style="font-size:13px" data-open-file="${esc(d.file_uid)}">${esc(d.file_uid)}</button>` : "—"}</dd>
    <dt>Создана</dt><dd class="sans">${fmtDate(d.created_at)}</dd></dl></div>`;
}
$("#searchBtn").addEventListener("click", doSearch);
$("#searchQ").addEventListener("keydown", (e) => e.key === "Enter" && doSearch());

/* ========================================================= */
setMode(mode);
renderHistory();
initConfig();
