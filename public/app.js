const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const input = $("input");
const sendBtn = $("send");
const state = { conversationId: null, controller: null };

const CITATION = /\[((?:Ch \d+|[A-Z][\w ]*?), pp?\. [^\]]+)\]/g;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(CITATION, (_, label) => `<button type="button" class="cite" data-citation="${label}">${label}</button>`);
}

function renderMarkdown(text) {
  const html = [];
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const item = /^[*-]\s+(.*)$/.exec(line);
    if (item) {
      list ??= [];
      list.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) {
      html.push(`<ul>${list.join("")}</ul>`);
      list = null;
    }
    if (line) html.push(`<p>${inline(line)}</p>`);
  }
  if (list) html.push(`<ul>${list.join("")}</ul>`);
  return html.join("");
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text) {
  $("empty")?.remove();
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  messagesEl.append(el);
  scrollToBottom();
}

function createAssistantMessage() {
  const el = document.createElement("div");
  el.className = "message assistant";
  el.innerHTML = `<div class="meta"></div><div class="bubble cursor"></div><div class="sources-slot"></div>`;
  messagesEl.append(el);
  el.sources = [];
  return el;
}

function setMeta(el, { standaloneQuestion, rewritten, route, model, ms }) {
  const meta = el.querySelector(".meta");
  const parts = [];
  if (rewritten) parts.push(`<span>searched for: “${escapeHtml(standaloneQuestion)}”</span>`);
  if (route) parts.push(`<span class="chip">${route.kind}${route.part ? ` · ${escapeHtml(route.part.replace(/:$/, ""))}` : ""}</span>`);
  if (model !== undefined) parts.push(`<span class="chip">${model ?? "no LLM call"}${ms ? ` · ${(ms / 1000).toFixed(1)}s` : ""}</span>`);
  meta.innerHTML = parts.join("");
}

function renderSources(el, cited = []) {
  const sources = el.sources;
  if (!sources.length) return;
  const items = sources
    .map(
      (s) =>
        `<li class="${cited.includes(s.id) ? "cited" : ""}"><button type="button" class="src" data-source="${s.id}">${escapeHtml(s.citation)}</button> ` +
        `<span>${escapeHtml(s.context)}${s.type === "summary" ? "" : ` · ${s.type}`}</span></li>`,
    )
    .join("");
  el.querySelector(".sources-slot").innerHTML = `<details class="sources"><summary>${sources.length} sources (${cited.length} cited)</summary><ol>${items}</ol></details>`;
}

function showSources(list, title) {
  $("sourceTitle").textContent = title;
  $("sourceBody").innerHTML = list.length
    ? list
        .map(
          (s) =>
            `<div class="source-card"><h3>${escapeHtml(s.citation)} · ${escapeHtml(s.type)}</h3>` +
            `<div class="path">${escapeHtml(s.context)}</div><pre>${escapeHtml(s.excerpt ?? "(excerpt not stored for this message)")}</pre></div>`,
        )
        .join("")
    : "<p>No matching source.</p>";
  $("sourcePanel").hidden = false;
}

messagesEl.addEventListener("click", (e) => {
  const target = e.target.closest("button");
  if (!target) return;
  const message = target.closest(".message");
  if (target.classList.contains("cite")) {
    const label = `[${target.dataset.citation}]`;
    showSources(message.sources.filter((s) => s.citation === label), label);
  } else if (target.classList.contains("src")) {
    const source = message.sources.find((s) => s.id === target.dataset.source);
    showSources(source ? [source] : [], source?.citation ?? "Source");
  } else if (target.closest(".suggestions")) {
    input.value = target.textContent;
    send();
  }
});

$("closeSource").addEventListener("click", () => ($("sourcePanel").hidden = true));

async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) yield { event, data: JSON.parse(data) };
    }
  }
}

function setBusy(busy) {
  sendBtn.textContent = busy ? "Stop" : "Send";
  sendBtn.classList.toggle("stop", busy);
  input.disabled = busy;
}

async function send() {
  if (state.controller) {
    state.controller.abort();
    return;
  }
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  autosize();
  addUserMessage(message);

  const el = createAssistantMessage();
  const bubble = el.querySelector(".bubble");
  let answer = "";
  let meta = {};
  state.controller = new AbortController();
  setBusy(true);

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId: state.conversationId ?? undefined, stream: true }),
      signal: state.controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed (${response.status})`);
    }

    for await (const { event, data } of readEvents(response)) {
      if (event === "conversation") {
        const isNew = state.conversationId !== data.conversationId;
        state.conversationId = data.conversationId;
        meta = { ...meta, standaloneQuestion: data.standaloneQuestion, rewritten: data.rewritten };
        if (isNew) loadConversations();
      } else if (event === "sources") {
        el.sources = data.sources;
        meta = { ...meta, route: data.route };
        renderSources(el);
      } else if (event === "delta") {
        answer += data.text;
        bubble.innerHTML = renderMarkdown(answer);
        scrollToBottom();
      } else if (event === "done") {
        meta = { ...meta, model: data.model, ms: data.ms };
        renderSources(el, data.cited);
      } else if (event === "error") {
        throw new Error(data.message);
      }
      setMeta(el, meta);
    }
  } catch (err) {
    if (err.name !== "AbortError") bubble.innerHTML += `<p class="error">${escapeHtml(err.message)}</p>`;
  } finally {
    bubble.classList.remove("cursor");
    state.controller = null;
    setBusy(false);
    input.focus();
    scrollToBottom();
  }
}

async function loadConversations() {
  const list = await fetch("/conversations").then((r) => r.json());
  $("conversations").innerHTML = list
    .map(
      (c) =>
        `<li class="${c.id === state.conversationId ? "active" : ""}" data-id="${c.id}">` +
        `<button type="button" class="open" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</button>` +
        `<button type="button" class="delete" aria-label="Delete conversation">×</button></li>`,
    )
    .join("");
}

async function openConversation(id) {
  const conversation = await fetch(`/conversations/${id}`).then((r) => (r.ok ? r.json() : null));
  if (!conversation) return loadConversations();
  state.conversationId = id;
  messagesEl.innerHTML = "";
  for (const m of conversation.messages) {
    if (m.role === "user") {
      addUserMessage(m.content);
      continue;
    }
    const el = createAssistantMessage();
    el.sources = m.sources ?? [];
    el.querySelector(".bubble").classList.remove("cursor");
    el.querySelector(".bubble").innerHTML = renderMarkdown(m.content);
    setMeta(el, { route: m.route, model: m.model });
    const cited = el.sources.filter((s) => m.content.includes(s.citation)).map((s) => s.id);
    renderSources(el, cited);
  }
  $("sidebar").classList.remove("open");
  $("sourcePanel").hidden = true;
  loadConversations();
  scrollToBottom();
}

$("conversations").addEventListener("click", async (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  if (e.target.classList.contains("delete")) {
    await fetch(`/conversations/${li.dataset.id}`, { method: "DELETE" });
    if (li.dataset.id === state.conversationId) newChat();
    loadConversations();
  } else {
    openConversation(li.dataset.id);
  }
});

function newChat() {
  state.conversationId = null;
  window.location.hash = "";
  messagesEl.innerHTML = "";
  messagesEl.append(emptyTemplate.cloneNode(true));
  $("sourcePanel").hidden = true;
  loadConversations();
  input.focus();
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

const emptyTemplate = $("empty").cloneNode(true);
$("newChat").addEventListener("click", newChat);
$("menu").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send();
});
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

loadConversations();
input.focus();
