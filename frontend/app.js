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

function addSources(box, sources) {
  if (!sources || !sources.length) return;
  const s = document.createElement("div");
  s.className = "sources";
  s.textContent = "Sources: " + sources.join(", ");
  box.appendChild(s);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Separate chats (saved in this browser only) ----------
const chatsKey = () => `syllabai-chats-${user.id}`;   // one saved set of chats per account
const MAX_CHATS = 30;
const GREETING = "Hi! Add your notes on the left, then ask me anything about them.";
let chats = [];        // newest first: { id, title, messages: [{ kind, text, sources }], history: [...] }
let activeId = null;
let busy = false;      // true while an answer is being written; chats can't be switched then

function loadChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(chatsKey()));
    if (saved && Array.isArray(saved.chats)) { chats = saved.chats; activeId = saved.activeId; }
  } catch { /* nothing saved yet, or storage blocked: start fresh */ }
}

function saveChats() {
  try { localStorage.setItem(chatsKey(), JSON.stringify({ chats, activeId })); } catch { /* storage full or blocked */ }
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
  chat.messages.forEach((m) => {
    const box = addMessage(m.text, m.kind);
    if (m.kind === "bot") addSources(box, m.sources);
  });
}

// Draw the list of chats in the sidebar
function renderChatList() {
  chatList.replaceChildren();
  chats.forEach((chat) => {
    const row = document.createElement("li");
    if (chat.id === activeId) row.classList.add("active");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "chat-open";
    open.textContent = chat.title;
    open.title = chat.title;
    open.disabled = busy;
    open.addEventListener("click", () => switchChat(chat.id));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "chat-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Delete chat: ${chat.title}`);
    del.disabled = busy;
    del.addEventListener("click", () => deleteChat(chat.id));

    row.append(open, del);
    chatList.appendChild(row);
  });
  newChatBtn.disabled = busy;
}

function switchChat(id) {
  if (busy || id === activeId) return;
  activeId = id;
  saveChats();
  renderChat();
  renderChatList();
  question.focus();
}

function newChat() {
  if (busy) return;
  // Re-use the current chat if it is still empty, so "New chat" doesn't pile up blanks
  if (!activeChat().messages.length) { question.focus(); return; }
  createChat();
  saveChats();
  renderChat();
  renderChatList();
  question.focus();
}

function deleteChat(id) {
  if (busy) return;
  const chat = chats.find((c) => c.id === id);
  if (!window.confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
  chats = chats.filter((c) => c.id !== id);
  if (!chats.length) createChat();
  else if (id === activeId) activeId = chats[0].id;
  saveChats();
  renderChat();
  renderChatList();
}

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
    return { answer, sources: [] };
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
  const handleLine = (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.error) throw new Error(msg.error);
    if (msg.sources) sources = msg.sources;
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
  return { answer, sources };
}

// Which file the questions and study buttons use ("" = all notes)
function currentScope() { return scope.value || null; }

async function askServer(text, onText) {
  const chat = activeChat();
  const reply = await streamFrom("/chat/stream", { question: text, history: chat.history, source: currentScope() }, onText);
  // Remember this turn (in this chat only) so follow-up questions have context
  chat.history.push({ role: "user", content: text }, { role: "assistant", content: reply.answer });
  chat.history.splice(0, Math.max(0, chat.history.length - 6));
  return reply;
}

function studyServer(mode, onText) {
  return streamFrom("/study/stream", { mode, source: currentScope() }, onText);
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
    addSources(box, reply.sources);
    // Save the exchange so it is still here after a reload or a switch to another chat
    chat.messages.push({ kind: "user", text: label }, { kind: "bot", text: reply.answer, sources: reply.sources });
    if (chat.title === "New chat") chat.title = label.length > 40 ? label.slice(0, 40) + "…" : label;
    saveChats();
  } catch (err) {
    waiting.remove();
    addMessage(`Couldn't reach the server. Check that it's running, then ask again. (${err.message})`, "bot", "error");
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
  saveChats();
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

async function uploadFile(file) {
  const status = addFileRow(file.name);
  try {
    if (MOCK) {
      await sleep(600);
    } else {
      const body = new FormData();
      body.append("file", file);
      const res = await apiFetch("/upload", { method: "POST", body });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }
    }
    status.textContent = "Ready";
    status.classList.add("done");
    status.parentElement.remove();       // the saved row from the server replaces it
    await refreshFiles();
  } catch (err) {
    status.textContent = "Failed";
    status.title = err.message;          // hover to see why
    status.classList.add("error");
    addMessage(`Couldn't add ${file.name}: ${err.message}`, "bot", "error");
  }
}

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
let authMode = "login";                 // "login" or "signup"

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

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  document.getElementById("tab-login").setAttribute("aria-selected", String(!signup));
  document.getElementById("tab-signup").setAttribute("aria-selected", String(signup));
  document.getElementById("name-row").hidden = !signup;
  document.getElementById("auth-hint").hidden = !signup;
  authName.required = signup;
  authPass.autocomplete = signup ? "new-password" : "current-password";
  authSubmit.textContent = signup ? "Create account" : "Sign in";
  authError.textContent = "";
}
document.getElementById("tab-login").addEventListener("click", () => setAuthMode("login"));
document.getElementById("tab-signup").addEventListener("click", () => setAuthMode("signup"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.textContent = "";
  authSubmit.disabled = true;
  try {
    const signup = authMode === "signup";
    const data = await authRequest(signup ? "/auth/signup" : "/auth/login", {
      name: authName.value, email: authEmail.value, password: authPass.value,
    });
    setToken(data.token);
    authForm.reset();
    enterApp(data.user);
  } catch (err) {
    authError.textContent = err.message === "Failed to fetch" ? "Can't reach the server. Check that it's running." : err.message;
  } finally {
    authSubmit.disabled = false;
  }
});

// Show the signed-in app for this user
function enterApp(account) {
  user = account;
  authBox.hidden = true;
  profileBox.hidden = true;
  profileBtn.hidden = false;
  document.getElementById("profile-name").textContent = user.name;
  document.getElementById("avatar").textContent = (user.name.trim()[0] || "?").toUpperCase();
  chats = [];
  activeId = null;
  loadChats();                          // this account's saved chats
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
  if (!window.confirm("Delete your account, notes and uploaded files? This can't be undone.")) return;
  const oldKey = chatsKey();
  profileCall("del-msg", "/auth/account", "DELETE", { password: document.getElementById("del-password").value }, () => {
    try { localStorage.removeItem(oldKey); } catch { /* ignore */ }
    showAuth();
  });
});

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

// ---------- Start: sign in with the saved token, or show the sign-in screen ----------
(async function start() {
  if (MOCK) { enterApp({ id: 0, name: "Demo", email: "demo@example.com" }); return; }
  if (!getToken()) { showAuth(); return; }
  try {
    const res = await apiFetch("/auth/me");
    enterApp((await res.json()).user);
  } catch (err) {
    if (err.message === "SIGNED_OUT") return;          // apiFetch already showed the sign-in screen
    showAuth(false);                                   // server unreachable: keep the token for next time
    authError.textContent = "Can't reach the server. Check that it's running, then reload.";
  }
})();
