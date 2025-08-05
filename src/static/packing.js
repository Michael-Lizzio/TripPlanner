let source = null;
let _packing = { items: [], users: [], _meta: {participants: 0} };
let _me = null, _isAdmin = false;

let pendingDeleteId = null;

window.onload = async () => {
  await fetchMe();
  await fetchPacking();
  ensureSSE();
  wireAddForm();
};

async function fetchMe(){
  const r = await fetch("/api/me");
  if (r.ok){
    const j = await r.json();
    _me = j.user; _isAdmin = !!j.is_admin;
  }
}
async function fetchPacking(){
  const r = await fetch("/api/packing");
  if (r.ok){ _packing = await r.json(); renderPacking(); }
}

function ensureSSE(){
  if (source) return;
  source = new EventSource("/stream");
  source.onmessage = (e)=>{
    try{
      const msg = JSON.parse(e.data);
      if (msg.type === "packing"){
        _packing = msg.data;
        renderPacking();
      }
    }catch(_){}
  };
  source.onerror = ()=>{
    source && source.close(); source = null;
    setTimeout(ensureSSE, 1500);
  };
}

function wireAddForm(){
  const form = document.getElementById("addShared");
  form.onsubmit = async (e)=>{
    e.preventDefault();
    const text = form.text.value.trim();
    const qty  = parseInt(form.qty.value || "1", 10);
    const cat  = form.cat.value;
    if (!text) return;
    await fetch("/api/packing/add", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({text, qty, category: cat})
    });
    form.reset();
    form.qty.value = 1;
  };
}

/* ───────── Render ───────── */
function renderPacking(){
  const root = document.getElementById("pack-root");
  root.innerHTML = "";

  const cats = ["items","snacks","other"];
  const titles = { items:"Items", snacks:"Snacks", other:"Other" };

  cats.forEach(cat=>{
    const items = _packing.items.filter(it=>it.category===cat);
    const wrap = document.createElement("details");
    wrap.className = "cat";
    wrap.open = true;

    const summary = document.createElement("summary");
    summary.className = "cat-title";
    summary.textContent = titles[cat];
    wrap.appendChild(summary);

    const list = document.createElement("div");
    list.className = "cat-list";
    if (!items.length){
      const empty = document.createElement("div");
      empty.className = "ev-meta";
      empty.textContent = "No items yet.";
      list.appendChild(empty);
    } else {
      items.forEach(it => list.appendChild(renderItem(it)));
    }

    wrap.appendChild(list);
    root.appendChild(wrap);
  });
}

function renderItem(it){
  const meOwner = it.user === _me;
  const hearts = Object.keys(it.hearts_by || {}).length;

  const row = document.createElement("div");
  row.className = "pack-item";
  row.innerHTML = `
    <div class="txt">
      <div class="name">${escapeHTML(it.text)}</div>
      <div class="meta">x${Number(it.qty||1)} · by ${escapeHTML(it.user)}</div>
    </div>
    <div class="actions">
      <button class="btn heart ${it.hearts_by && it.hearts_by[_me] ? "on" : ""}" title="Heart" onclick="toggleHeart(${it.id})">
        ❤️ <span>${hearts}</span>
      </button>
      ${meOwner || _isAdmin ? `<button class="btn" onclick="askDelete(${it.id})">Delete</button>` : ""}
    </div>
  `;
  return row;
}

/* ───────── Actions ───────── */
async function toggleHeart(pid){
  await fetch(`/api/packing/toggle_heart/${pid}`, { method:"POST" });
}
function askDelete(pid){
  pendingDeleteId = pid;
  document.getElementById("confirmDlg").showModal();
}
function closeConfirm(){
  pendingDeleteId = null;
  document.getElementById("confirmDlg").close();
}
async function confirmDelete(){
  if (!pendingDeleteId) return;
  await fetch(`/api/packing/delete/${pendingDeleteId}`, { method:"POST" });
  closeConfirm();
}

/* ───────── Helpers ───────── */
function escapeHTML(s){ return (s||"").replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
