// ---------- Settings ----------
// MOCK = true  -> fake replies, no server needed (Phase 2).
// MOCK = false -> talk to the real Flask server (from Phase 3 on).
const MOCK = false;
// Opened as a file: talk to the local server. Served by the server itself (e.g. on Render): same address.
const API_URL = location.protocol === "file:" ? "http://127.0.0.1:5000" : location.origin;

// ---------- Talking to the server (adds the password when one is set) ----------
const KEY_NAME = "syllabai-key";
function getKey() { try { return sessionStorage.getItem(KEY_NAME) || ""; } catch { return ""; } }
function setKey(k) { try { sessionStorage.setItem(KEY_NAME, k); } catch { /* storage blocked: ask again next time */ } }

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const key = getKey();
  if (key) headers["X-Access-Key"] = key;
  const res = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (res.status === 401) { showLogin(); throw new Error("Password needed"); }
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
const loginBox  = document.getElementById("login");
const loginForm = document.getElementById("login-form");
const loginKey  = document.getElementById("login-key");
const loginErr  = document.getElementById("login-error");

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

// ---------- Asking a question ----------
const history = [];   // recent turns sent along with each question
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
  const reply = await streamFrom("/chat/stream", { question: text, history, source: currentScope() }, onText);
  // Remember this turn so follow-up questions have context
  history.push({ role: "user", content: text }, { role: "assistant", content: reply.answer });
  history.splice(0, Math.max(0, history.length - 6));
  return reply;
}

function studyServer(mode, onText) {
  return streamFrom("/study/stream", { mode, source: currentScope() }, onText);
}

// Shows a user bubble, then the answer as it streams in. run(onText) must return { answer, sources }.
async function ask(label, run) {
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
  } catch (err) {
    waiting.remove();
    addMessage(`Couldn't reach the server. Check that it's running, then ask again. (${err.message})`, "bot", "error");
  } finally {
    setBusy(false);
    question.focus();
  }
}

// Disable every button that talks to the model while an answer is being written
function setBusy(busy) {
  sendBtn.disabled = busy;
  document.querySelectorAll("[data-study]").forEach((b) => { b.disabled = busy; });
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

// Clear chat: wipes the screen and the memory the model sees
clearBtn.addEventListener("click", () => {
  history.length = 0;
  messages.replaceChildren();
  addMessage("Chat cleared. Ask me anything about your notes.", "bot");
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

function handleFiles(files) {
  for (const file of files) {
    const ok = /\.(pdf|txt)$/i.test(file.name);
    if (ok) {
      uploadFile(file);
    } else {
      const status = addFileRow(file.name);
      status.textContent = "Only PDF or .txt";
      status.classList.add("error");
    }
  }
}

fileInput.addEventListener("change", () => {
  handleFiles(fileInput.files);
  fileInput.value = "";                 // lets you pick the same file again
});

["dragenter", "dragover"].forEach((name) =>
  dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((name) =>
  dropzone.addEventListener(name, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

// ---------- Password box (only appears when the server has APP_PASSWORD set) ----------
function showLogin() {
  setKey("");
  loginBox.hidden = false;
  loginKey.value = "";
  loginKey.focus();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setKey(loginKey.value);
  loginErr.textContent = "";
  try {
    const res = await apiFetch("/files");   // any protected route works as a password check
    if (!res.ok) throw new Error();
    loginBox.hidden = true;
    refreshFiles();
  } catch {
    loginErr.textContent = "Wrong password. Try again.";
  }
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

// ---------- Start ----------
(async function start() {
  if (!MOCK) {
    try {
      const res = await fetch(`${API_URL}/health`);
      if ((await res.json()).auth && !getKey()) { showLogin(); return; }
    } catch { /* server down: the notes list will just stay empty */ }
  }
  refreshFiles();                       // show notes already stored from earlier visits
})();
