// ---------- Settings ----------
// MOCK = true  -> fake replies, no server needed (Phase 2).
// MOCK = false -> talk to the real Flask server (from Phase 3 on).
const MOCK = false;
const API_URL = "http://127.0.0.1:5000";

// ---------- Grab the page elements we need ----------
const dropzone  = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileList  = document.getElementById("file-list");
const messages  = document.getElementById("messages");
const form      = document.getElementById("chat-form");
const question  = document.getElementById("question");
const sendBtn   = document.getElementById("send");

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
async function askServer(text) {
  if (MOCK) {
    await sleep(800);
    return { answer: `(Fake answer) You asked: "${text}".`, sources: [] };
  }
  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: text, history }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  // Remember this turn so follow-up questions have context
  history.push({ role: "user", content: text }, { role: "assistant", content: data.answer });
  history.splice(0, Math.max(0, history.length - 6));
  return data;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();               // stop the page from reloading
  const text = question.value.trim();
  if (!text) return;

  addMessage(text, "user");
  question.value = "";
  question.style.height = "auto";
  sendBtn.disabled = true;
  const waiting = addMessage("Reading your notes…", "bot", "thinking");

  try {
    waiting.remove();
    const reply = await askServer(text);
    addSources(addMessage(reply.answer, "bot"), reply.sources);
  } catch (err) {
    addMessage(`Couldn't reach the server. Check that it's running, then ask again. (${err.message})`, "bot", "error");
  } finally {
    sendBtn.disabled = false;
    question.focus();
  }
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

async function refreshFiles() {
  if (MOCK) return;
  try {
    const res = await fetch(`${API_URL}/files`);
    if (!res.ok) throw new Error();
    const { files } = await res.json();
    fileList.querySelectorAll("[data-saved]").forEach((r) => r.remove());
    const empty = fileList.querySelector(".empty");
    if (empty) empty.remove();
    files.slice().reverse().forEach((f) => fileList.prepend(addSavedRow(f)));
    showEmptyIfNeeded();
  } catch (err) {
    // server not running yet; the list stays as it is
  }
}

async function removeFile(name, button) {
  button.disabled = true;
  try {
    const res = await fetch(`${API_URL}/files/${encodeURIComponent(name)}`, { method: "DELETE" });
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
      const res = await fetch(`${API_URL}/upload`, { method: "POST", body });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
    }
    status.textContent = "Ready";
    status.classList.add("done");
    status.parentElement.remove();       // the saved row from the server replaces it
    await refreshFiles();
  } catch (err) {
    status.textContent = "Failed";
    status.classList.add("error");
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

refreshFiles();                         // show notes already stored from earlier visits
