const state = {
  token: sessionStorage.getItem("ostensory.worker.token") || "",
  publicUpload: false,
  canUpload: false,
  offset: 0,
  loading: false,
};

const $ = (selector) => document.querySelector(selector);
const gallery = $("#gallery");
const empty = $("#empty");
const loadMore = $("#load-more");
const input = $("#file-input");
const dropzone = $("#dropzone");
const status = $("#upload-status");
const health = $("#health");
const dialog = $("#token-dialog");
const tokenInput = $("#token-input");

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

function setStatus(message, error = false) {
  status.textContent = message || "";
  status.classList.toggle("error", error);
}

function authHeaders(extra = {}) {
  return state.token ? { ...extra, Authorization: `Bearer ${state.token}` } : extra;
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const body = await response.json();
    state.publicUpload = Boolean(body.public_upload);
    state.canUpload = Boolean(body.upload_enabled);
    health.textContent = response.ok ? "Worker 在线" : "Worker 异常";
    health.classList.toggle("ok", response.ok);
    health.classList.toggle("bad", !response.ok);
    if (state.publicUpload) {
      $("#token-button").textContent = "管理员 Token";
    }
  } catch {
    health.textContent = "连接失败";
    health.classList.add("bad");
  }
}

function openTokenDialog() {
  tokenInput.value = state.token;
  dialog.showModal();
  setTimeout(() => tokenInput.focus(), 30);
}

async function uploadFiles(files) {
  if (!files || files.length === 0) return;
  if (!state.canUpload) {
    toast("这个 Worker 没有开启上传。", true);
    return;
  }
  if (!state.publicUpload && !state.token) {
    openTokenDialog();
    toast("先填写管理员 Token。", true);
    return;
  }
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const button = dropzone;
  button.classList.add("is-uploading");
  setStatus(`正在上传 ${files.length} 个文件…`);
  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      state.token = "";
      sessionStorage.removeItem("ostensory.worker.token");
      openTokenDialog();
      throw new Error("Token 无效，请重新填写。");
    }
    if (!response.ok) {
      throw new Error(body.error || `上传失败：HTTP ${response.status}`);
    }
    const created = body.created?.length || 0;
    const duplicates = body.duplicates?.length || 0;
    const errors = body.errors || [];
    const summary = [
      created ? `上传 ${created} 张` : "",
      duplicates ? `跳过重复 ${duplicates} 张` : "",
      errors.length ? `${errors.length} 张失败` : "",
    ].filter(Boolean).join("，");
    setStatus(summary || "完成", errors.length > 0);
    if (errors.length) toast(errors.slice(0, 3).join("；"), true);
    else toast(summary || "上传完成");
    await loadImages(true);
  } catch (error) {
    setStatus(error.message || "上传失败", true);
    toast(error.message || "上传失败", true);
  } finally {
    button.classList.remove("is-uploading");
    input.value = "";
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast("链接已复制");
  } catch {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
    toast("链接已复制");
  }
}

function renderCard(item) {
  const card = document.createElement("article");
  card.className = "card";
  const link = document.createElement("a");
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener";
  const image = document.createElement("img");
  image.loading = "lazy";
  image.src = item.url;
  image.alt = item.filename || "image";
  link.append(image);

  const body = document.createElement("div");
  body.className = "card-body";
  const name = document.createElement("div");
  name.className = "card-name";
  name.textContent = item.filename || "image";
  name.title = item.filename || "";
  const meta = document.createElement("div");
  meta.className = "card-meta";
  const size = document.createElement("span");
  size.textContent = formatBytes(item.size);
  const date = document.createElement("span");
  date.textContent = formatDate(item.created_at);
  meta.append(size, date);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "复制链接";
  copy.addEventListener("click", () => copyText(new URL(item.url, location.origin).href));
  const open = document.createElement("a");
  open.href = item.url;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "打开";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "删除";
  remove.addEventListener("click", () => deleteImage(item));
  actions.append(copy, open, remove);

  body.append(name, meta, actions);
  card.append(link, body);
  return card;
}

async function deleteImage(item) {
  if (!state.token) {
    openTokenDialog();
    toast("删除需要管理员 Token。", true);
    return;
  }
  if (!confirm(`确定删除 ${item.filename || "这张图片"}？`)) return;
  try {
    const response = await fetch(`/api/images/${encodeURIComponent(item.id)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `删除失败：HTTP ${response.status}`);
    toast("已删除");
    await loadImages(true);
  } catch (error) {
    toast(error.message || "删除失败", true);
  }
}

async function loadImages(reset = false) {
  if (state.loading) return;
  if (reset) {
    state.offset = 0;
    gallery.replaceChildren();
  }
  state.loading = true;
  loadMore.disabled = true;
  try {
    const response = await fetch(`/api/images?limit=24&offset=${state.offset}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "加载失败");
    const items = body.items || [];
    for (const item of items) gallery.append(renderCard(item));
    state.offset = body.next_offset ?? state.offset + items.length;
    loadMore.hidden = !body.next_offset;
    empty.hidden = gallery.children.length > 0;
    $("#count").textContent = gallery.children.length ? `${gallery.children.length} 张` : "";
  } catch (error) {
    toast(error.message || "加载失败", true);
  } finally {
    state.loading = false;
    loadMore.disabled = false;
  }
}

dropzone.addEventListener("click", () => input.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    input.click();
  }
});
input.addEventListener("change", () => uploadFiles(input.files));
for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
}
dropzone.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

$("#token-button").addEventListener("click", openTokenDialog);
dialog.addEventListener("close", () => {
  if (dialog.returnValue === "cancel") return;
  const next = tokenInput.value.trim();
  state.token = next;
  if (next) sessionStorage.setItem("ostensory.worker.token", next);
  else sessionStorage.removeItem("ostensory.worker.token");
  if (next) toast("Token 已保存");
});
$("#load-more").addEventListener("click", () => loadImages(false));
loadMore.hidden = true;

checkHealth().then(() => loadImages(true));