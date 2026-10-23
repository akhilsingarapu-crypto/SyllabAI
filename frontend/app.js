// ---------- Settings ----------
// MOCK = true  -> fake replies, no server needed (Phase 2).
// MOCK = false -> talk to the real Flask server (from Phase 3 on).
const MOCK = false;
// Opened as a file: talk to the local server. Served by the server itself (e.g. on Render): same address.
const API_URL = location.protocol === "file:" ? "http://127.0.0.1:5000" : location.origin;

// ---------- Talking to the server (sends your sign-in token) ----------
const TOKEN_KEY = "syllabai-token";
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function setToken(t) {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: sign in again next visit */ }
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) { showAuth(); throw new Error("SIGNED_OUT"); }
  return res;
}

// ---------- Grab the page elements we need ----------
const dropzone  = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileList  = document.getElementById("file-list");
const messages  = document.getElementById("messages");
const form      = document.getElementById("chat-form");
const question  = document.getElementById("question");
const sendBtn   = document.getElementById("send");
const scope     = document.getElementById("scope");
const clearBtn  = document.getElementById("clear-chat");
const exportBtn = document.getElementById("export-chat");
const authBox    = document.getElementById("auth");
const authForm   = document.getElementById("auth-form");
const authName   = document.getElementById("auth-name");
const authEmail  = document.getElementById("auth-email");
const authPass   = document.getElementById("auth-password");
const authError  = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const profileBtn = document.getElementById("profile-btn");
const profileBox = document.getElementById("profile");
const chatList  = document.getElementById("chat-list");
const newChatBtn = document.getElementById("new-chat");
const attachBtn   = document.getElementById("attach");
const attachInput = document.getElementById("attach-input");
const micBtn      = document.getElementById("mic");
const lang        = document.getElementById("lang");
const knowledge   = document.getElementById("knowledge");
const chatSearch  = document.getElementById("chat-search");
const authCode    = document.getElementById("auth-code");
const themeBtn    = document.getElementById("theme-btn");
const deleteAllBtn = document.getElementById("delete-all");

// ---------- Chat helpers ----------
function addMessage(text, kind, extraClass = "") {
  const box = document.createElement("div");
  box.className = `msg ${kind} ${extraClass}`.trim();
  if (kind === "user") {
    const p = document.createElement("p");
    p.textContent = text;          // textContent (not innerHTML) keeps text safe
    box.appendChild(p);
  } else {
    renderRich(box, text);
  }
  messages.appendChild(box);
  messages.scrollTop = messages.scrollHeight;
  return box;
}

// Turns "**bold**" and "- bullets" into real elements. Uses textContent only, so it stays safe.
function addInline(parent, text) {
  text.split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const b = document.createElement("strong");
      b.textContent = part;
      parent.appendChild(b);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

function renderRich(box, text) {
  let list = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
    if (bullet) {
      if (!list) { list = document.createElement("ul"); box.appendChild(list); }
      const li = document.createElement("li");
      addInline(li, bullet[1]);
      list.appendChild(li);
    } else {
      list = null;
      const p = document.createElement("p");
      addInline(p, line.replace(/^#{1,6}\s+/, ""));
      box.appendChild(p);
    }
  }
}

function addSources(box, sources, passages) {
  if (sources && sources.length) {
    const s = document.createElement("div");
    s.className = "sources";
    s.textContent = "Sources: " + sources.join(", ");
    box.appendChild(s);
  }
  // The exact note text the answer was based on, so you can check it
  if (passages && passages.length) {
    const details = document.createElement("details");
    details.className = "passages";
    const summary = document.createElement("summary");
    summary.textContent = `Show the ${passages.length} passage${passages.length > 1 ? "s" : ""} used`;
    details.appendChild(summary);
    passages.forEach((p) => {
      const quote = document.createElement("blockquote");
      const cite = document.createElement("cite");
      cite.textContent = p.source + (p.page ? ` (p. ${p.page})` : "");
      quote.append(cite, document.createTextNode(p.text));
      details.appendChild(quote);
    });
    box.appendChild(details);
  }
}

// 👍 👎 and "Save PDF" under an answer. rec is the saved message (it remembers your rating).
function addActions(box, rec, label, chat) {
  const bar = document.createElement("div");
  bar.className = "actions";
  const make = (text, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    return b;
  };
  const up = make("👍", "Good answer");
  const down = make("👎", "Bad answer");
  const pdf = make("Save PDF", "Download this answer as a PDF");

  const paint = () => {
    up.classList.toggle("picked", rec.rating === "up");
    down.classList.toggle("picked", rec.rating === "down");
    up.disabled = down.disabled = Boolean(rec.rating);
  };
  const rate = async (rating) => {
    rec.rating = rating;
    paint();
    try {
      await apiFetch("/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, question: label, answer: rec.text, sources: rec.sources || [] }),
      });
      persist(chat);
    } catch {
      rec.rating = undefined;           // it didn't reach the server: let them try again
      paint();
    }
  };
  up.addEventListener("click", () => rate("up"));
  down.addEventListener("click", () => rate("down"));

  pdf.addEventListener("click", async () => {
    pdf.disabled = true;
    try {
      const res = await apiFetch("/export/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: label, text: rec.text }),
      });
      if (!res.ok) throw new Error();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await res.blob());
      link.download = "syllabai.pdf";
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      pdf.textContent = "PDF failed";
      setTimeout(() => { pdf.textContent = "Save PDF"; }, 2000);
    } finally {
      pdf.disabled = false;
    }
  });

  paint();
  bar.append(up, down, pdf);
  box.appendChild(bar);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Separate chats (saved on the server, per account) ----------
const activeKey = () => `syllabai-active-${user.id}`;     // which chat was open (remembered per device)
const oldChatsKey = () => `syllabai-chats-${user.id}`;    // where earlier versions kept chats: this browser
const MAX_CHATS = 30;
const GREETING = "Hi! Add your notes on the left, then ask me anything about them.";
let chats = [];        // most recently used first: { id, title, messages: [{ kind, text, sources, passages, rating }], history: [...] }
let activeId = null;
let busy = false;      // true while an answer is being written; chats can't be switched then

async function loadChats() {
  chats = [];
  try {
    const res = await apiFetch("/chats");
    if (res.ok) chats = (await res.json()).chats;
  } catch (err) {
    if (err.message === "SIGNED_OUT") throw err;
  }
  if (!chats.length) await migrateLocalChats();
  try { activeId = localStorage.getItem(activeKey()); } catch { activeId = null; }
}

// One time: chats the older version kept in this browser are copied up to the account
async function migrateLocalChats() {
  let old = null;
  try { old = JSON.parse(localStorage.getItem(oldChatsKey())); } catch { /* none */ }
  if (!old || !Array.isArray(old.chats)) return;
  for (const chat of old.chats.filter((c) => c.messages && c.messages.length)) {
    chats.push(chat);
    await persist(chat);
  }
  try { localStorage.removeItem(oldChatsKey()); } catch { /* ignore */ }
}

// Save one chat to the server and move it to the top of the list
async function persist(chat) {
  const i = chats.indexOf(chat);
  if (i > 0) { chats.splice(i, 1); chats.unshift(chat); }
  try {
    await apiFetch(`/chats/${chat.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: chat.title, messages: chat.messages, history: chat.history }),
    });
  } catch { /* offline or too long: it stays on screen and is saved again after the next change */ }
}

function saveActive() {
  try { localStorage.setItem(activeKey(), activeId); } catch { /* storage blocked */ }
}

const activeChat = () => chats.find((c) => c.id === activeId);

function createChat() {
  const chat = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: "New chat", messages: [], history: [] };
  chats.unshift(chat);
  chats.splice(MAX_CHATS);               // drop the oldest beyond the limit
  activeId = chat.id;
  return chat;
}

// Draw the active chat's messages in the main area
function renderChat() {
  messages.replaceChildren();
  const chat = activeChat();
  if (!chat.messages.length) addMessage(GREETING, "bot");
  let lastUser = "";
  chat.messages.forEach((m) => {
    const box = addMessage(m.text, m.kind);
    if (m.kind === "user") { lastUser = m.text; return; }
    addSources(box, m.sources, m.passages);
    addActions(box, m, lastUser, chat);
  });
}

// Draw the list of chats in the sidebar
function renderChatList() {
  chatList.replaceChildren();
  chatSearch.hidden = chats.length < 5;          // searching only helps once there are a few chats
  const needle = chatSearch.hidden ? "" : chatSearch.value.trim().toLowerCase();
  chats.filter((chat) => chat.title.toLowerCase().includes(needle)).forEach((chat) => {
    const row = document.createElement("li");
    if (chat.id === activeId) row.classList.add("active");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "chat-open";
    open.textContent = chat.title;
    open.title = chat.title;
    open.disabled = busy;
    open.addEventListener("click", () => switchChat(chat.id));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "chat-edit";
    edit.textContent = "✎";
    edit.setAttribute("aria-label", `Rename chat: ${chat.title}`);
    edit.disabled = busy;
    edit.addEventListener("click", () => renameChat(chat));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Delete chat: ${chat.title}`);
    del.disabled = busy;
    del.addEventListener("click", () => deleteChat(chat.id));

    row.append(open, edit, del);
    chatList.appendChild(row);
  });
  newChatBtn.disabled = busy;
}

function switchChat(id) {
  if (busy || id === activeId) return;
  activeId = id;
  saveActive();
  renderChat();
  renderChatList();
  question.focus();
}

function newChat() {
  if (busy) return;
  // Re-use the current chat if it is still empty, so "New chat" doesn't pile up blanks
  if (!activeChat().messages.length) { question.focus(); return; }
  createChat();
  saveActive();
  renderChat();
  renderChatList();
  question.focus();
}

function deleteChat(id) {
  if (busy) return;
  const chat = chats.find((c) => c.id === id);
  if (!window.confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
  chats = chats.filter((c) => c.id !== id);
  apiFetch(`/chats/${id}`, { method: "DELETE" }).catch(() => { /* the server copy goes at the next clean-up */ });
  if (!chats.length) createChat();
  else if (id === activeId) activeId = chats[0].id;
  saveActive();
  renderChat();
  renderChatList();
}

function renameChat(chat) {
  if (busy) return;
  const title = window.prompt("Rename this chat:", chat.title);
  if (title === null) return;                      // cancelled
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!clean) return;
  chat.title = clean;
  persist(chat);
  renderChatList();
}

chatSearch.addEventListener("input", renderChatList);
newChatBtn.addEventListener("click", newChat);

// ---------- Asking a question ----------
// Reads the answer as it is written. The server sends one JSON object per line:
// {"sources": [...]}, then many {"delta": "text"}, or {"error": "..."}.
// onText(fullAnswerSoFar) is called after every piece; returns { answer, sources }.
async function streamFrom(path, payload, onText) {
  if (MOCK) {
    await sleep(800);
    const answer = `(Fake answer) You asked: "${payload.question || payload.mode}".`;
    onText(answer);
    return { answer, sources: [], passages: [] };
  }
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${res.status}`);
  }

  let answer = "";
  let sources = [];
  let passages = [];
  const handleLine = (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.error) throw new Error(msg.error);
    if (msg.sources) sources = msg.sources;
    if (msg.passages) passages = msg.passages;
    if (msg.delta) { answer += msg.delta; onText(answer); }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();               // last piece may be half a line; keep it for next time
    lines.forEach(handleLine);
  }
  handleLine(buffer);
  return { answer, sources, passages };
}

// Which file the questions and study buttons use ("" = all notes)
function currentScope() { return scope.value || null; }

// "Answer in" choice ("" = same language as the question); remembered on this device
const LANG_KEY = "syllabai-lang";
try { lang.value = localStorage.getItem(LANG_KEY) || ""; } catch { /* storage blocked */ }
lang.addEventListener("change", () => {
  try { localStorage.setItem(LANG_KEY, lang.value); } catch { /* storage blocked */ }
});
function currentLanguage() { return lang.value || null; }

// "Answer from": my notes only, or notes first and then the AI's general knowledge (marked as such)
const KNOWLEDGE_KEY = "syllabai-knowledge";
try { knowledge.value = localStorage.getItem(KNOWLEDGE_KEY) === "general" ? "general" : "notes"; } catch { /* storage blocked */ }
knowledge.addEventListener("change", () => {
  try { localStorage.setItem(KNOWLEDGE_KEY, knowledge.value); } catch { /* storage blocked */ }
});

async function askServer(text, onText) {
  const chat = activeChat();
  const reply = await streamFrom(
    "/chat/stream",
    { question: text, history: chat.history, source: currentScope(), language: currentLanguage(), knowledge: knowledge.value },
    onText,
  );
  // Remember this turn (in this chat only) so follow-up questions have context
  chat.history.push({ role: "user", content: text }, { role: "assistant", content: reply.answer });
  chat.history.splice(0, Math.max(0, chat.history.length - 6));
  return reply;
}

function studyServer(mode, onText) {
  return streamFrom("/study/stream", { mode, source: currentScope(), language: currentLanguage() }, onText);
}

// Shows a user bubble, then the answer as it streams in. run(onText) must return { answer, sources }.
async function ask(label, run) {
  const chat = activeChat();            // the chat this answer belongs to (can't change while busy)
  if (messages.querySelector(".msg.bot") && !chat.messages.length) messages.replaceChildren();  // drop the greeting
  addMessage(label, "user");
  setBusy(true);
  const waiting = addMessage("Reading your notes…", "bot", "thinking");
  let box = null;                       // the answer bubble, created when the first words arrive

  try {
    const reply = await run((partial) => {
      if (!box) { waiting.remove(); box = addMessage("", "bot"); }
      box.replaceChildren();
      renderRich(box, partial);
      messages.scrollTop = messages.scrollHeight;
    });
    if (!box) { waiting.remove(); box = addMessage(reply.answer || "(No answer)", "bot"); }
    addSources(box, reply.sources, reply.passages);
    // Save the exchange so it is still here after a reload, a switch to another chat, or on another device
    const saved = { kind: "bot", text: reply.answer, sources: reply.sources, passages: reply.passages };
    chat.messages.push({ kind: "user", text: label }, saved);
    if (chat.title === "New chat") chat.title = label.length > 40 ? label.slice(0, 40) + "…" : label;
    addActions(box, saved, label, chat);
    await persist(chat);
  } catch (err) {
    waiting.remove();
    if (err.message === "SIGNED_OUT") return;
    const network = err.message === "Failed to fetch";
    addMessage(network ? "Couldn't reach the server. Check that it's running, then ask again." : err.message, "bot", "error");
  } finally {
    setBusy(false);
    question.focus();
  }
}

// Disable every button that talks to the model, and the chat list, while an answer is being written
function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  document.querySelectorAll("[data-study]").forEach((b) => { b.disabled = value; });
  renderChatList();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();               // stop the page from reloading
  const text = question.value.trim();
  if (!text) return;
  question.value = "";
  question.style.height = "auto";
  ask(text, (onText) => askServer(text, onText));
});

// Study buttons: summary / quiz / flashcards for the chosen file
const STUDY_LABELS = { summary: "Summarize", quiz: "Quiz me", flashcards: "Make flashcards" };
document.querySelectorAll("[data-study]").forEach((btn) =>
  btn.addEventListener("click", () => {
    const mode = btn.dataset.study;
    const where = scope.value ? ` — ${scope.value}` : " — all notes";
    ask(STUDY_LABELS[mode] + where, (onText) => studyServer(mode, onText));
  })
);

// Clear chat: empties this chat (screen, saved messages and the memory the model sees)
clearBtn.addEventListener("click", () => {
  if (busy) return;
  const chat = activeChat();
  chat.messages = [];
  chat.history = [];
  chat.title = "New chat";
  persist(chat);
  renderChat();
  renderChatList();
});

// Enter sends, Shift+Enter adds a new line
question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

// Grow the text box as you type
question.addEventListener("input", () => {
  question.style.height = "auto";
  question.style.height = question.scrollHeight + "px";
});

// ---------- Uploading notes ----------
function showEmptyIfNeeded() {
  if (!fileList.children.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No notes yet. Add one to get started.";
    fileList.appendChild(li);
  }
}

function addFileRow(name) {
  const empty = fileList.querySelector(".empty");
  if (empty) empty.remove();

  const row = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = name;
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = "Uploading…";
  row.append(label, status);
  fileList.appendChild(row);
  return status;
}

// Rows for notes the server has stored. Each has a remove button.
function addSavedRow(file) {
  const row = document.createElement("li");
  row.dataset.saved = "1";
  const label = document.createElement("span");
  label.textContent = file.name;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "remove";
  del.textContent = "Remove";
  del.setAttribute("aria-label", `Remove ${file.name}`);
  del.addEventListener("click", () => removeFile(file.name, del));
  row.append(label, del);
  return row;
}

// Fill the "Ask in" dropdown with the stored files, keeping the current choice if it still exists
function updateScope(files) {
  const chosen = scope.value;
  scope.replaceChildren(new Option("All notes", ""));
  files.forEach((f) => scope.add(new Option(f.name, f.name)));
  scope.value = files.some((f) => f.name === chosen) ? chosen : "";
}

async function refreshFiles() {
  if (MOCK) return;
  try {
    const res = await apiFetch("/files");
    if (!res.ok) throw new Error();
    const { files } = await res.json();
    fileList.querySelectorAll("[data-saved]").forEach((r) => r.remove());
    const empty = fileList.querySelector(".empty");
    if (empty) empty.remove();
    files.slice().reverse().forEach((f) => fileList.prepend(addSavedRow(f)));
    showEmptyIfNeeded();
    updateScope(files);
  } catch (err) {
    // server not running yet; the list stays as it is
  }
}

async function removeFile(name, button) {
  button.disabled = true;
  try {
    const res = await apiFetch(`/files/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    await refreshFiles();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Failed";
  }
}

// Upload with a progress callback (fetch can't report upload progress, XMLHttpRequest can)
function uploadWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/upload`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((100 * e.loaded) / e.total)); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 401) { showAuth(); reject(new Error("SIGNED_OUT")); return; }
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data.error || `Server returned ${xhr.status}`)); return; }
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Can't reach the server."));
    const body = new FormData();
    body.append("file", file);
    xhr.send(body);
  });
}

async function uploadFile(file) {
  const status = addFileRow(file.name);
  try {
    let result = {};
    if (MOCK) {
      await sleep(600);
    } else {
      result = await uploadWithProgress(file, (percent) => {
        // once everything is sent the server still has to read and index the file
        status.textContent = percent < 100 ? `Uploading ${percent}%` : "Reading the file…";
      });
    }
    status.textContent = "Ready";
    status.classList.add("done");
    status.parentElement.remove();       // the saved row from the server replaces it
    await refreshFiles();
    // For photos, show what was read: handwriting and blurry pictures are often misread
    if (result.preview && /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file.name)) {
      scope.value = file.name;           // questions now use this photo until you change "Ask in"
      addMessage(`I read this from ${file.name}: “${result.preview}${result.preview.length >= 200 ? "…" : ""}” — "Ask in" is now set to this photo. If that looks wrong, try a clearer, well-lit, printed or typed page.`, "bot");
    }
  } catch (err) {
    if (err.message === "SIGNED_OUT") return;
    status.textContent = "Failed";
    status.title = err.message;          // hover to see why
    status.classList.add("error");
    addMessage(`Couldn't add ${file.name}: ${err.message}`, "bot", "error");
  }
}

// "Delete all": removes every uploaded note after a confirmation
deleteAllBtn.addEventListener("click", async () => {
  if (!fileList.querySelector("[data-saved]")) return;       // nothing to delete
  if (!window.confirm("Delete ALL your uploaded notes? Your chats and account stay. This can't be undone.")) return;
  deleteAllBtn.disabled = true;
  try {
    const res = await apiFetch("/files", { method: "DELETE" });
    if (!res.ok) throw new Error();
    await refreshFiles();
  } catch (err) {
    if (err.message !== "SIGNED_OUT") addMessage("Couldn't delete your notes. Try again.", "bot", "error");
  } finally {
    deleteAllBtn.disabled = false;
  }
});

// File types the server can read (keep in step with SUPPORTED in backend/ingest.py)
const FILE_TYPES = [
  ".pdf", ".docx", ".pptx", ".xlsx", ".epub", ".html", ".htm",
  ".txt", ".md", ".csv", ".tsv", ".json", ".log",
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff",
];
fileInput.accept = attachInput.accept = FILE_TYPES.join(",");

function handleFiles(files) {
  for (const file of files) {
    const ok = FILE_TYPES.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (ok) {
      uploadFile(file);
    } else {
      const status = addFileRow(file.name);
      status.textContent = "Type not supported";
      status.classList.add("error");
    }
  }
}

fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
  fileInput.value = "";                 // lets you pick the same file again
});

// 📎 button beside the question box: same upload, without leaving the chat
attachBtn.addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", () => {
  handleFiles(attachInput.files);
  attachInput.value = "";
});

// 🎤 button: speak the question (browser speech recognition; Chrome and Edge)
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRec) {
  micBtn.hidden = true;                 // this browser can't do it
} else {
  const rec = new SpeechRec();
  rec.lang = navigator.language || "en-US";
  rec.interimResults = true;
  let before = "";                      // what was already typed when listening started

  const setListening = (on) => {
    micBtn.classList.toggle("on", on);
    micBtn.setAttribute("aria-pressed", String(on));
  };
  rec.onresult = (event) => {
    const heard = [...event.results].map((r) => r[0].transcript).join(" ");
    question.value = `${before} ${heard}`.trim();
    question.style.height = "auto";
    question.style.height = question.scrollHeight + "px";
  };
  rec.onend = () => setListening(false);
  rec.onerror = (event) => {
    setListening(false);
    const why = event.error === "not-allowed" ? "Microphone access is blocked. Allow it in the address bar." : `Voice input stopped (${event.error}).`;
    addMessage(why, "bot", "error");
  };
  micBtn.addEventListener("click", () => {
    if (micBtn.classList.contains("on")) { rec.stop(); return; }
    before = question.value;
    try { rec.start(); setListening(true); } catch { /* already starting */ }
  });
}

["dragenter", "dragover"].forEach((name) =>
  dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((name) =>
  dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

// ---------- Accounts: sign in / create account ----------
let user = null;                        // { id, email, name } while signed in
let authMode = "login";                 // "login", "signup", "forgot" (ask for a reset link) or "reset" (choose a new password)
let resetToken = "";                    // from the link in the reset email
let needsCode = false;                  // true when the server asks new accounts for an invite code

// Sign-in and sign-up have no token yet, so they use plain fetch instead of apiFetch
async function authRequest(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

function setAuthMode(mode, info = "") {
  authMode = mode;
  const signup = mode === "signup", forgot = mode === "forgot", reset = mode === "reset";
  document.querySelector(".tabs").hidden = !(mode === "login" || signup);
  document.getElementById("tab-login").setAttribute("aria-selected", String(mode === "login"));
  document.getElementById("tab-signup").setAttribute("aria-selected", String(signup));
  document.getElementById("name-row").hidden = !signup;
  document.getElementById("code-row").hidden = !(signup && needsCode);
  authCode.required = signup && needsCode;
  document.getElementById("email-row").hidden = reset;
  document.getElementById("pass-row").hidden = forgot;
  document.getElementById("pass-label").textContent = reset ? "New password" : "Password";
  document.getElementById("auth-hint").hidden = !(signup || reset);
  document.getElementById("auth-forgot").hidden = mode !== "login";
  document.getElementById("auth-back").hidden = !(forgot || reset);
  authName.required = signup;
  authEmail.required = !reset;
  authPass.required = !forgot;
  authPass.autocomplete = signup || reset ? "new-password" : "current-password";
  authSubmit.textContent = { login: "Sign in", signup: "Create account", forgot: "Send reset link", reset: "Set new password" }[mode];
  authError.textContent = "";
  document.getElementById("auth-info").textContent = info;
}
document.getElementById("tab-login").addEventListener("click", () => setAuthMode("login"));
document.getElementById("tab-signup").addEventListener("click", () => setAuthMode("signup"));
document.getElementById("auth-forgot").addEventListener("click", () => setAuthMode("forgot"));
document.getElementById("auth-back").addEventListener("click", () => setAuthMode("login"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.textContent = "";
  authSubmit.disabled = true;
  try {
    if (authMode === "forgot") {
      const data = await authRequest("/auth/forgot", { email: authEmail.value });
      setAuthMode("login", data.message);
      return;
    }
    if (authMode === "reset") {
      const data = await authRequest("/auth/reset", { token: resetToken, new: authPass.value });
      resetToken = "";
      authForm.reset();
      setAuthMode("login", data.message);
      return;
    }
    const signup = authMode === "signup";
    const data = await authRequest(signup ? "/auth/signup" : "/auth/login", {
      name: authName.value, email: authEmail.value, password: authPass.value, code: authCode.value,
    });
    setToken(data.token);
    authForm.reset();
    await enterApp(data.user);
  } catch (err) {
    authError.textContent = err.message === "Failed to fetch" ? "Can't reach the server. Check that it's running." : err.message;
  } finally {
    authSubmit.disabled = false;
  }
});

// Show the signed-in app for this user
async function enterApp(account) {
  user = account;
  authBox.hidden = true;
  profileBox.hidden = true;
  profileBtn.hidden = false;
  document.getElementById("profile-name").textContent = user.name;
  document.getElementById("avatar").textContent = (user.name.trim()[0] || "?").toUpperCase();
  chats = [];
  activeId = null;
  try {
    await loadChats();                  // this account's saved chats, from the server
  } catch {
    return;                             // signed out while loading: the sign-in screen is already showing
  }
  if (!chats.length) createChat();
  else if (!activeChat()) activeId = chats[0].id;
  renderChat();
  renderChatList();
  refreshFiles();                       // this account's notes
}

// Show the sign-in screen and forget everything about the previous user
function showAuth(forgetToken = true) {
  if (forgetToken) setToken("");
  user = null;
  chats = [];
  activeId = null;
  messages.replaceChildren();
  chatList.replaceChildren();
  fileList.replaceChildren();
  updateScope([]);
  showEmptyIfNeeded();
  profileBtn.hidden = true;
  profileBox.hidden = true;
  authBox.hidden = false;
  setAuthMode("login");
  authEmail.focus();
}

// ---------- Profile ----------
function setMsg(el, text, ok) {
  el.textContent = text;
  el.className = "form-msg " + (text ? (ok ? "ok" : "bad") : "");
}

function openProfile() {
  document.getElementById("profile-email").textContent = user.email;
  document.getElementById("prof-name").value = user.name;
  ["name-msg", "pw-msg", "del-msg"].forEach((id) => setMsg(document.getElementById(id), ""));
  ["pw-form", "del-form"].forEach((id) => document.getElementById(id).reset());
  profileBox.hidden = false;
  document.getElementById("prof-name").focus();
}
const closeProfile = () => { profileBox.hidden = true; profileBtn.focus(); };

profileBtn.addEventListener("click", openProfile);
document.getElementById("profile-close").addEventListener("click", closeProfile);
profileBox.addEventListener("click", (e) => { if (e.target === profileBox) closeProfile(); });   // click outside the card
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !profileBox.hidden) closeProfile(); });

// Run an API call for a profile form; shows the result (or the server's reason) under the form
async function profileCall(msgId, path, method, body, onOk) {
  const msg = document.getElementById(msgId);
  setMsg(msg, "");
  try {
    const res = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    onOk(data, msg);
  } catch (err) {
    if (err.message !== "SIGNED_OUT") setMsg(msg, err.message, false);
  }
}

document.getElementById("name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  profileCall("name-msg", "/auth/profile", "PATCH", { name: document.getElementById("prof-name").value }, (data, msg) => {
    user = data.user;
    document.getElementById("profile-name").textContent = user.name;
    document.getElementById("avatar").textContent = (user.name.trim()[0] || "?").toUpperCase();
    setMsg(msg, "Saved.", true);
  });
});

document.getElementById("pw-form").addEventListener("submit", (event) => {
  event.preventDefault();
  profileCall("pw-msg", "/auth/password", "POST", {
    current: document.getElementById("pw-current").value,
    new: document.getElementById("pw-new").value,
  }, (_data, msg) => {
    document.getElementById("pw-form").reset();
    setMsg(msg, "Password changed. Your other devices were signed out.", true);
  });
});

document.getElementById("signout").addEventListener("click", async () => {
  try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* already signed out, or server down */ }
  showAuth();
});

document.getElementById("del-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!window.confirm("Delete your account, chats, notes and uploaded files? This can't be undone.")) return;
  const keys = [activeKey(), oldChatsKey()];   // this device's leftovers for the account
  profileCall("del-msg", "/auth/account", "DELETE", { password: document.getElementById("del-password").value }, () => {
    keys.forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    showAuth();
  });
});

// ---------- Practice: quiz (typed answers, marked by the AI) or flip cards ----------
const practiceBox = document.getElementById("practice");
const $p = (id) => document.getElementById(id);
const practice = { kind: "quiz", items: [], index: 0, score: 0, missed: [] };

function showPracticePart(part) {          // "setup", "run" or "done"
  ["setup", "run", "done"].forEach((p) => { $p(`practice-${p}`).hidden = p !== part; });
}

function openPractice() {
  $p("practice-scope-note").textContent =
    `Uses ${scope.value ? scope.value : "all your notes"}. Change it with "Ask in" before opening this.`;
  setMsg($p("practice-msg"), "");
  $p("start-quiz").disabled = $p("start-cards").disabled = false;
  showPracticePart("setup");
  practiceBox.hidden = false;
}
const closePractice = () => { practiceBox.hidden = true; };

$p("open-practice").addEventListener("click", openPractice);
$p("practice-close").addEventListener("click", closePractice);
$p("p-close2").addEventListener("click", closePractice);
$p("p-again").addEventListener("click", openPractice);
practiceBox.addEventListener("click", (e) => { if (e.target === practiceBox) closePractice(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !practiceBox.hidden) closePractice(); });

async function startPractice(kind) {
  const msg = $p("practice-msg");
  setMsg(msg, "Making your questions… this takes a few seconds.", true);
  $p("start-quiz").disabled = $p("start-cards").disabled = true;
  try {
    const res = await apiFetch("/practice/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, source: currentScope(), language: currentLanguage() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    Object.assign(practice, { kind, items: data.items, index: 0, score: 0, missed: [] });
    showPracticePart("run");
    showPracticeItem();
  } catch (err) {
    if (err.message !== "SIGNED_OUT") setMsg(msg, err.message, false);
    $p("start-quiz").disabled = $p("start-cards").disabled = false;
  }
}
$p("start-quiz").addEventListener("click", () => startPractice("quiz"));
$p("start-cards").addEventListener("click", () => startPractice("cards"));

function showPracticeItem() {
  const quiz = practice.kind === "quiz";
  const item = practice.items[practice.index];
  $p("practice-progress").textContent = `${quiz ? "Question" : "Card"} ${practice.index + 1} of ${practice.items.length}`;
  $p("practice-q").textContent = item.q;
  const answer = $p("practice-answer");
  answer.value = "";
  answer.hidden = !quiz;
  answer.disabled = false;
  $p("practice-a").hidden = true;
  setMsg($p("practice-feedback"), "");
  $p("p-check").hidden = !quiz;
  $p("p-check").disabled = false;
  $p("p-flip").hidden = quiz;
  ["p-knew", "p-missed", "p-next"].forEach((id) => { $p(id).hidden = true; });
  if (quiz) answer.focus();
}

// Reveal the model answer, then offer the next step
function revealAnswer(next) {
  const item = practice.items[practice.index];
  $p("practice-a").textContent = `Answer: ${item.a}`;
  $p("practice-a").hidden = false;
  $p("p-check").hidden = true;
  $p("p-flip").hidden = true;
  next.forEach((id) => { $p(id).hidden = false; });
}

$p("p-check").addEventListener("click", async () => {
  const answer = $p("practice-answer").value.trim();
  const feedback = $p("practice-feedback");
  if (!answer) { setMsg(feedback, "Type your answer first.", false); return; }
  const item = practice.items[practice.index];
  $p("p-check").disabled = true;
  $p("practice-answer").disabled = true;
  setMsg(feedback, "Marking…", true);
  try {
    const res = await apiFetch("/practice/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: item.q, expected: item.a, answer, language: currentLanguage() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    const label = { correct: "✓ Correct.", partly: "◐ Partly right.", wrong: "✗ Not quite." }[data.verdict];
    practice.score += data.verdict === "correct" ? 1 : data.verdict === "partly" ? 0.5 : 0;
    if (data.verdict !== "correct") practice.missed.push(item);
    setMsg(feedback, `${label} ${data.feedback}`, data.verdict === "correct");
    revealAnswer(["p-next"]);
  } catch (err) {
    if (err.message !== "SIGNED_OUT") setMsg(feedback, err.message, false);
    $p("p-check").disabled = false;
    $p("practice-answer").disabled = false;
  }
  updateNextLabel();
});

$p("p-flip").addEventListener("click", () => revealAnswer(["p-knew", "p-missed"]));
$p("p-knew").addEventListener("click", () => { practice.score += 1; advancePractice(); });
$p("p-missed").addEventListener("click", () => { practice.missed.push(practice.items[practice.index]); advancePractice(); });
$p("p-next").addEventListener("click", advancePractice);

function updateNextLabel() {
  $p("p-next").textContent = practice.index + 1 >= practice.items.length ? "See my score" : "Next";
}

function advancePractice() {
  practice.index += 1;
  if (practice.index < practice.items.length) { showPracticeItem(); return; }
  const total = practice.items.length;
  const shown = Number.isInteger(practice.score) ? practice.score : practice.score.toFixed(1);
  $p("practice-score").textContent = practice.kind === "quiz"
    ? `You scored ${shown} out of ${total}.`
    : `You knew ${shown} of ${total} cards.`;
  const list = $p("practice-missed-list");
  list.replaceChildren();
  if (practice.missed.length) {
    const title = document.createElement("p");
    title.className = "hint";
    title.textContent = "Worth another look:";
    list.appendChild(title);
    practice.missed.forEach((item) => {
      const p = document.createElement("p");
      p.textContent = `${item.q} — ${item.a}`;
      list.appendChild(p);
    });
  }
  showPracticePart("done");
}

// ---------- Export the chat as a text file ----------
exportBtn.addEventListener("click", () => {
  const lines = [...messages.querySelectorAll(".msg:not(.thinking)")].map((m) => {
    const who = m.classList.contains("user") ? "You" : "SyllabAI";
    const body = [...m.children].map((c) => c.innerText.trim()).filter(Boolean).join("\n");
    return `${who}:\n${body}`;
  });
  if (lines.length <= 1) return;           // only the greeting: nothing worth saving
  const blob = new Blob([lines.join("\n\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "syllabai-chat.txt";
  link.click();
  URL.revokeObjectURL(link.href);
});

// ---------- Light / dark theme ----------
const THEME_KEY = "syllabai-theme";
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "light" ? "🌙" : "☀";
  themeBtn.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
}
let theme = "dark";
try { theme = localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; } catch { /* storage blocked */ }
applyTheme(theme);
themeBtn.addEventListener("click", () => {
  theme = theme === "light" ? "dark" : "light";
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage blocked */ }
});

// ---------- Start: sign in with the saved token, or show the sign-in screen ----------
(async function start() {
  if (MOCK) { enterApp({ id: 0, name: "Demo", email: "demo@example.com" }); return; }

  try {                                 // does this server ask for an invite code at sign-up?
    needsCode = Boolean((await (await fetch(`${API_URL}/health`)).json()).signup_code);
  } catch { /* server unreachable: handled below */ }

  // Opened from the link in a password-reset email: ask for the new password
  const reset = location.hash.match(/^#reset=([\w-]+)$/);
  if (reset) {
    resetToken = reset[1];
    history.replaceState(null, "", location.pathname + location.search);   // keep the token out of the address bar
    showAuth();
    setAuthMode("reset");
    return;
  }

  if (!getToken()) { showAuth(); return; }
  try {
    const res = await apiFetch("/auth/me");
    await enterApp((await res.json()).user);
  } catch (err) {
    if (err.message === "SIGNED_OUT") return;          // apiFetch already showed the sign-in screen
    showAuth(false);                                   // server unreachable: keep the token for next time
    authError.textContent = "Can't reach the server. Check that it's running, then reload.";
  }
})();
