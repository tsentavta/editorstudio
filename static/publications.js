"use strict";

let publicationRequest = 0;

function publicationPayload(response) {
  return response.data?.data || {};
}

function articlePayload(response) {
  return response.data?.article || publicationPayload(response).article || {};
}

async function publicationStatuses(uids, silent = false) {
  const response = await call("POST", "/api/v2/publications/status/batch",
    { json: { article_uids: uids }, silent });
  const rows = Array.isArray(response.data) ? response.data : publicationPayload(response);
  return { response, statuses: new Map(Array.isArray(rows) ? rows.map((row) => [row.article_uid, row]) : []) };
}

function publicationSummary(uid, data, showSignature) {
  const file = data.file_uid
    ? `<button type="button" class="link mono" data-open-file="${esc(data.file_uid)}">${esc(data.file_uid)}</button>`
    : "–";
  return `<div class="sub"><dl class="kv">
    <dt>ID публикации</dt><dd>${esc(uid)}</dd>
    <dt>PDF</dt><dd class="sans">${data.has_pdf === undefined ? "–" : data.has_pdf ? "есть" : "нет"}</dd>
    <dt>Файл загрузки</dt><dd>${file}</dd>
    <dt>Создана</dt><dd class="sans">${fmtDate(data.created_at)}</dd>
    ${showSignature && data.signed_at !== undefined
      ? `<dt>Подписание</dt><dd class="sans">${data.signed_at ? `Подписана ${fmtDate(data.signed_at)}` : "Не подписана"}</dd>`
      : ""}
  </dl></div>`;
}

async function loadPub(value, by) {
  const q = value.trim();
  const request = ++publicationRequest;
  const out = $("#searchResult"), button = $("#searchBtn");
  const options = { query: $("#searchPublic").checked ? { public: "true" } : undefined };
  $("#pubResult").replaceChildren();
  pubCache = null;
  if (!q) { out.textContent = "Введите DOI, EDN или ID публикации."; busy(button, false); return; }
  busy(button, true);
  out.textContent = "Ищу публикацию…";
  try {
    let lookup, uid = q;
    if (by !== "uid") {
      lookup = await call("GET", publicationPath(by, q), options);
      if (request !== publicationRequest) return;
      if (!lookup.ok) {
        if (by !== "edn" || lookup.status !== 404) { out.innerHTML = errorHtml(lookup); return; }
        lookup = undefined;
      } else {
        uid = publicationPayload(lookup).article_uid;
        if (!uid) { out.textContent = "API не вернул ID публикации."; return; }
      }
    }
    const details = await call("GET", publicationPath("uid", uid));
    if (request !== publicationRequest) return;
    if (!details.ok && !lookup) { out.innerHTML = errorHtml(details); return; }
    const article = articlePayload(details);
    const locales = Object.values(article);
    const doi = locales.find((locale) => locale?.doi)?.doi;
    const edn = locales.find((locale) => locale?.edn)?.edn;
    let extra = lookup;
    let notice = details.ok ? "" : "Метаданные статьи по ID недоступны.";
    if (details.ok && by !== "doi") {
      if (doi || (edn && !lookup)) {
        const index = await call("GET", publicationPath(doi ? "doi" : "edn", doi || edn), options);
        if (request !== publicationRequest) return;
        if (index.ok && publicationPayload(index).article_uid === uid) extra = index;
        else notice = "Не удалось подтвердить совпадение записи по DOI или EDN с ID статьи.";
      } else if (!extra) {
        notice = "В статье нет DOI и EDN для дополнительной проверки.";
      }
    }

    const metadata = extra && publicationPayload(extra);
    out.innerHTML = metadata ? publicationSummary(uid, metadata, !details.ok || !locales.length) : "";
    if (notice) out.insertAdjacentHTML("beforeend", `<p class="hint">${esc(notice)}</p>`);
    if (!details.ok) return;
    if (!locales.length) { out.insertAdjacentHTML("beforeend", '<p class="hint">Публикация без метаданных.</p>'); return; }

    let sig = metadata;
    if (sig?.signed_at === undefined) {
      const { statuses } = await publicationStatuses([uid], true);
      if (request !== publicationRequest) return;
      sig = statuses.get(uid);
    }
    pubCache = { uid, article, sig };
    pubLocale = null;
    renderPub();
  } finally {
    if (request === publicationRequest) busy(button, false);
  }
}

$("#publicationSearch").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("#searchQ").value.trim();
  const by = /^10\.\d{4,9}\/\S+$/.test(normalizeDoi(value)) ? "doi" : /^[a-z]{6}$/i.test(value) ? "edn" : "uid";
  loadPub(value, by);
});

const signingForm = $("#signingForm"), signingOut = $("#batchResult"), signingMessage = $("#signingMessage");
const signingInput = $("#batchUids"), signingButton = $("#batchBtn");
let signingUids = [], signingStatuses = new Map();

function renderSigning() {
  if (!signingUids.length) { signingOut.replaceChildren(); return; }
  signingOut.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th scope="col">ID публикации</th><th scope="col">Статус</th><th scope="col">Действие</th>
  </tr></thead><tbody>${signingUids.map((uid) => {
    const status = signingStatuses.get(uid);
    const articleLink = `<button type="button" class="link mono" data-open-art="${esc(uid)}">${esc(uid)}</button>`;
    if (!status || status.signed_at === undefined) {
      return `<tr><td>${articleLink}</td><td colspan="2">Статус недоступен</td></tr>`;
    }
    const signed = Boolean(status.signed_at);
    const label = signed ? "Подписана " + fmtDate(status.signed_at)
      : status.unsigned_at ? "Подпись отозвана " + fmtDate(status.unsigned_at) : "Не подписана";
    return `<tr><td>${articleLink}</td><td>${esc(label)}</td><td>
      <button type="button" class="btn btn-sm ${signed ? "btn-ghost btn-danger" : "btn-primary"}"
        data-sign-uid="${esc(uid)}" data-sign-action="${signed ? "unsign" : "sign"}">
        ${signed ? "Отозвать подпись" : "Подписать"}
      </button></td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function setSigningBusy(on) {
  busy(signingButton, on);
  signingInput.readOnly = on;
  $$("[data-sign-uid]", signingOut).forEach((button) => { button.disabled = on; });
}

signingInput.addEventListener("input", () => {
  signingUids = [];
  signingMessage.replaceChildren();
  renderSigning();
});

signingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (signingButton.disabled) return;
  signingUids = [];
  renderSigning();
  const uids = [...new Set(signingInput.value.split(/[\s,;]+/).filter(Boolean))];
  if (!uids.length || uids.length > 100) {
    signingMessage.textContent = "Укажите от 1 до 100 ID публикаций.";
    return;
  }
  setSigningBusy(true);
  signingMessage.textContent = "Проверяю статусы…";
  try {
    const { response, statuses } = await publicationStatuses(uids);
    if (!response.ok) { signingMessage.innerHTML = errorHtml(response); return; }
    signingUids = uids;
    signingStatuses = statuses;
    renderSigning();
    signingMessage.textContent = "Проверено публикаций: " + uids.length;
  } finally { setSigningBusy(false); }
});

signingOut.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-sign-uid]");
  if (!button || signingButton.disabled) return;
  const { signUid: uid, signAction: action } = button.dataset;
  const signing = action === "sign";
  if (!confirm((signing ? "Подписать публикацию" : "Отозвать подпись публикации") + " " + uid + "?"
    + (signing ? "\nПосле подписания загрузка PDF недоступна до отзыва подписи." : ""))) return;
  setSigningBusy(true);
  try {
    const response = await call("PUT", publicationPath("uid", uid) + "/" + action + "/");
    if (!response.ok && response.status !== 409) { signingMessage.innerHTML = errorHtml(response); return; }
    const refreshed = await publicationStatuses([uid], true);
    const status = refreshed.statuses.get(uid);
    signingStatuses.set(uid, status);
    renderSigning();
    const message = response.ok ? (signing ? "Публикация подписана." : "Подпись отозвана.")
      : "Статус публикации изменился. Проверьте актуальные данные.";
    signingMessage.textContent = message + (status ? "" : " Не удалось обновить статус.");
    if (pubCache?.uid === uid) {
      pubCache.sig = status;
      renderPub();
    }
    if (document.body.dataset.tab === "signing") {
      const control = $$("[data-sign-uid]", signingOut).find((control) => control.dataset.signUid === uid);
      (control || signingButton).focus();
    }
  } finally { setSigningBusy(false); }
});
