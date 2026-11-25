const issuePdfDois = $("#pdfIssueDois"), issuePdfFind = $("#pdfIssueFind");
const issuePdfInput = $("#pdfIssueFiles"), issuePdfDrop = $("#pdfIssueDrop");
const issuePdfRows = $("#pdfIssueRows"), issuePdfStatus = $("#pdfIssueStatus");
const issuePdfSend = $("#pdfIssueSend");
let issuePdfs = [];
let issuePublications = [];
let issuePdfBusy = false;

function issueDoiList(text) {
  return [...new Set(text.split(/\r?\n/).map((line) => normalizeDoi(line).toLowerCase()).filter(Boolean))];
}

function issuePdfAssignable(row) {
  return row.state === "ready" || row.state === "error";
}

function issuePdfMatch() {
  for (const row of issuePublications) {
    if (!issuePdfAssignable(row)) continue;
    const matches = issuePdfs.filter((pdf) => pdf.dois.length === 1 && pdf.dois[0] === row.doi);
    row.pdf = matches.length === 1 ? matches[0] : null;
  }
}

function issuePdfReady() {
  const counts = new Map();
  for (const row of issuePublications) {
    if (row.pdf) counts.set(row.pdf, (counts.get(row.pdf) || 0) + 1);
  }
  return issuePublications.filter((row) => issuePdfAssignable(row) && row.pdf
    && counts.get(row.pdf) === 1
    && (!row.pdf.dois.length || row.pdf.dois.includes(row.doi)));
}

function issuePdfRender() {
  const ready = new Set(issuePdfReady());
  issuePdfSend.disabled = issuePdfBusy || !ready.size;
  issuePdfSend.textContent = ready.size ? `Прикрепить PDF (${ready.size})` : "Прикрепить PDF";
  $("#pdfIssueActions").hidden = !issuePublications.length;
  issuePdfRows.innerHTML = issuePublications.length ? `<div class="table-wrap"><table class="btable">
    <thead><tr><th>Статья и DOI</th><th>PDF</th><th>Статус</th></tr></thead>
    <tbody>${issuePublications.map((row, index) => {
      const selectable = issuePdfAssignable(row) && issuePdfs.length;
      const options = issuePdfs.map((pdf, i) => `<option value="${i}" ${pdf === row.pdf ? "selected" : ""}>${esc(pdf.file.name)}</option>`).join("");
      const file = selectable
        ? `<select data-pdf-issue-row="${index}" aria-label="PDF для ${esc(row.doi)}" ${issuePdfBusy ? "disabled" : ""}><option value="">Выберите PDF</option>${options}</select>`
        : esc(row.pdf?.file.name || "—");
      const preview = row.pdf ? ` <button type="button" class="btn btn-ghost btn-sm" data-pdf-preview="${index}">Просмотреть PDF</button>` : "";
      let message = row.message;
      if (issuePdfAssignable(row) && row.pdf && !ready.has(row)) {
        message = row.pdf.dois.length && !row.pdf.dois.includes(row.doi)
          ? "DOI в PDF относится к другой статье" : "Этот PDF выбран для нескольких статей";
      } else if (!message && ready.has(row)) {
        message = row.pdf.dois.length ? "DOI совпадает" : "Выбрано вручную";
      }
      return `<tr><td>${row.title ? `<b>${esc(row.title)}</b><br>` : ""}<span class="mono">${esc(row.doi)}</span></td>
        <td>${file}${preview}</td><td>${esc(message || "PDF не выбран")}</td></tr>`;
    }).join("")}</tbody></table></div>` : "";
}

function issuePdfSetBusy(on) {
  issuePdfBusy = on;
  issuePdfDois.disabled = issuePdfInput.disabled = on;
  busy(issuePdfFind, on);
  issuePdfRender();
}

async function issuePdfSelectFiles(list) {
  if (issuePdfBusy || !list.length) return;
  issuePdfs = [...list].filter((file) => file.size && /\.pdf$/i.test(file.name))
    .map((file) => ({ file, compact: "", dois: [] }));
  $("#pdfIssueFileCount").textContent = `Выбрано PDF: ${issuePdfs.length}`;
  for (const row of issuePublications) {
    if (issuePdfAssignable(row)) row.pdf = null;
  }
  await issuePdfScan();
}

async function issuePdfScan() {
  if (!issuePublications.length || !issuePdfs.length) { issuePdfRender(); return; }
  issuePdfSetBusy(true);
  let unreadable = 0;
  try {
    for (const [index, pdf] of issuePdfs.entries()) {
      issuePdfStatus.textContent = `Проверяю PDF ${index + 1} из ${issuePdfs.length}…`;
      try {
        if (!pdf.compact) {
          const { text } = await readPdfText(pdf.file);
          pdf.compact = text.toLowerCase().replace(/\s+/g, "");
        }
      } catch { unreadable++; }
      pdf.dois = issuePublications.filter((row) => pdfHasDoi(pdf, row.doi)).map((row) => row.doi);
    }
    issuePdfMatch();
    issuePdfStatus.textContent = unreadable
      ? `Для ${unreadable} PDF не удалось прочитать текст. Файлы можно выбрать вручную.` : "";
  } finally { issuePdfSetBusy(false); }
}

issuePdfDois.addEventListener("input", () => {
  issuePublications = [];
  issuePdfStatus.textContent = "";
  issuePdfRender();
});

issuePdfInput.addEventListener("change", () => {
  const files = [...issuePdfInput.files];
  issuePdfInput.value = "";
  issuePdfSelectFiles(files);
});
["dragenter", "dragover"].forEach((type) => issuePdfDrop.addEventListener(type, (event) => {
  event.preventDefault();
  if (!issuePdfBusy) issuePdfDrop.classList.add("is-over");
}));
issuePdfDrop.addEventListener("dragleave", () => issuePdfDrop.classList.remove("is-over"));
issuePdfDrop.addEventListener("drop", (event) => {
  event.preventDefault();
  issuePdfDrop.classList.remove("is-over");
  issuePdfSelectFiles(event.dataTransfer.files);
});

$("#pdfIssueLookup").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (issuePdfBusy) return;
  const dois = issueDoiList(issuePdfDois.value);
  if (!dois.length) { issuePdfStatus.textContent = "Введите DOI статей."; return; }
  issuePublications = [];
  issuePdfSetBusy(true);
  const seen = new Set();
  try {
    for (const [index, doi] of dois.entries()) {
      issuePdfStatus.textContent = `Проверяю DOI ${index + 1} из ${dois.length}…`;
      const row = { doi, state: "unavailable", title: "", message: "", uid: null, pdf: null };
      issuePublications.push(row);
      if (!/^10\.\d{4,9}\/\S+$/.test(doi)) {
        row.message = "Проверьте формат DOI";
        continue;
      }
      const lookup = await call("GET", publicationPath("doi", doi));
      const status = lookup.data?.data;
      if (!lookup.ok || !status?.article_uid) {
        row.message = lookup.ok ? "API не вернул идентификатор статьи" : errText(lookup);
        continue;
      }
      row.uid = status.article_uid;
      if (seen.has(row.uid)) {
        row.message = "Эта публикация уже есть в списке";
        continue;
      }
      seen.add(row.uid);
      const details = await call("GET", publicationPath("uid", row.uid));
      const article = details.data?.article || details.data?.data?.article || {};
      row.title = (article.RUS || article.ENG || Object.values(article)[0])?.title || "";
      if (!details.ok) { row.message = errText(details); continue; }
      if (status.has_pdf) { row.message = "PDF уже прикреплён"; continue; }
      if (status.signed_at) { row.message = "Статья подписана"; continue; }
      row.state = "ready";
    }
    issuePdfStatus.textContent = "";
  } finally { issuePdfSetBusy(false); }
  await issuePdfScan();
});

issuePdfRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-pdf-preview]");
  if (!button) return;
  const row = issuePublications[Number(button.dataset.pdfPreview)];
  if (row?.pdf) openPdfPreview(row.pdf.file, row.title || row.doi);
});

issuePdfRows.addEventListener("change", (event) => {
  const select = event.target.closest("[data-pdf-issue-row]");
  if (issuePdfBusy || !select) return;
  const row = issuePublications[Number(select.dataset.pdfIssueRow)];
  row.pdf = select.value === "" ? null : issuePdfs[Number(select.value)];
  if (row.state === "error") { row.state = "ready"; row.message = ""; }
  issuePdfRender();
});

issuePdfSend.addEventListener("click", async () => {
  if (issuePdfBusy) return;
  const ready = issuePdfReady();
  if (!ready.length) return;
  issuePdfSetBusy(true);
  let uploaded = 0;
  try {
    for (const [index, row] of ready.entries()) {
      issuePdfStatus.textContent = `Отправляю PDF ${index + 1} из ${ready.length}…`;
      const response = await uploadPublicationPdf(row.uid, row.pdf.file);
      row.state = response.ok ? "done" : "error";
      row.message = response.ok ? "PDF прикреплён" : errText(response);
      if (response.ok) uploaded++;
      issuePdfRender();
    }
    issuePdfStatus.textContent = `Прикреплено PDF: ${uploaded} из ${ready.length}. Ошибок: ${ready.length - uploaded}.`;
  } finally { issuePdfSetBusy(false); }
});
