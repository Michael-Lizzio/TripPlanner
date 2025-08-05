let source = null;

let currentDayIndex = null;
let editEventIndices = null;

let _meta = { participants: 0 };
let _data = null;
let _me = null;
let _isAdmin = false;

window.onload = async () => {
  await fetchMe();
  await fetchAndRender();
  ensureSSE();
};

async function fetchMe(){
  const r = await fetch("/api/me");
  if (r.ok){
    const j = await r.json();
    _me = j.user;
    _isAdmin = !!j.is_admin;
  }
}

async function fetchAndRender(){
  const res = await fetch("/api/data");
  const pack = await res.json();
  _meta = pack._meta || _meta;
  _data = pack;
  renderAll(pack);
}

function ensureSSE(){
  if (source) return;
  source = new EventSource("/stream");
  source.onmessage = (e)=>{
    try{
      const msg = JSON.parse(e.data);
      if (msg.type === "data"){
        _meta = (msg.data && msg.data._meta) || _meta;
        _data = msg.data;
        renderAll(msg.data);
      }
    }catch(_){}
  };
  source.onerror = ()=>{
    // Normal on server reload or network hiccup; auto-retry
    source && source.close(); source = null;
    setTimeout(ensureSSE, 1500);
  };
}

/* ——— Render ——— */
function renderAll(pack){
  const data = pack.days ? pack : _data;
  const days = data.days || [];
  const root = document.getElementById("container");
  root.innerHTML = "";

  days.forEach((day, di)=>{
    const card = document.createElement("section");
    card.className = "day";

    const head = document.createElement("div");
    head.className = "day-head";
    head.innerHTML = `
      <div class="date-pill">${fmtDate(day.date)}</div>
      <button class="add-btn" aria-label="Add" onclick="openAddEvent(${di})">+</button>
    `;
    card.appendChild(head);

    const list = document.createElement("div");
    list.className = "events";

    // group by time
    const byTime = {};
    (day.events || []).forEach((ev, ei)=>{
      const t = ev.time || "--:--";
      (byTime[t] ||= []).push({ev, ei});
    });

    Object.keys(byTime).sort((a,b)=>timeKey(a)-timeKey(b)).forEach(t=>{
      const group = byTime[t];
      if (group.length === 1){
        const {ev, ei} = group[0];
        list.appendChild(renderSingleEvent(ev, di, ei));
      }else{
        list.appendChild(renderTimeGroup(t, group, di));
      }
    });

    card.appendChild(list);
    root.appendChild(card);
  });

  document.addEventListener("click", closeAllMenus, {once:true});
}

function renderSingleEvent(ev, di, ei){
  const row = document.createElement("div");
  row.className = "event";

  const canManage = canManageEvent(ev);
  const myVote = getMyVote(ev);

  row.innerHTML = `
    <div class="time-badge">${fmtTime12(ev.time)}</div>
    <div class="ev-main">
      <div class="ev-title">${escapeHTML(ev.title || "(Untitled)")}</div>
      ${ev.desc ? `<div class="ev-desc">${escapeHTML(ev.desc)}</div>` : ""}
      ${renderMeta(ev)}
      <div class="ev-meta" style="margin-top:2px; align-items:center;">
        <button class="btn vote up ${myVote==='u'?'selected':''}" onclick="voteEvent(${di},${ei},1)">
          👍 <span class="count" onclick="showVoters(${di},${ei},event)">${Number(ev.ups||0)}</span>
        </button>
        <button class="btn vote down ${myVote==='d'?'selected':''}" onclick="voteEvent(${di},${ei},-1)">
          👎 <span class="count" onclick="showVoters(${di},${ei},event)">${Number(ev.downs||0)}</span>
        </button>
        <span class="add-option-chip" style="margin-left:auto" onclick="openAddEvent(${di}, '${ev.time || ""}')">+ Add option at ${fmtTime12(ev.time)}</span>
      </div>
    </div>
    <div class="kebab">
      <button aria-label="menu" onclick="toggleMenu(this)">⋮</button>
      <div class="menu">
        ${(isCreator(ev) || _isAdmin) ? `<button onclick="startEditEvent(${di},${ei})">Edit</button>` : ``}
        ${canManage ? `<button onclick="deleteEvent(${di},${ei})">Delete</button>` : ``}
      </div>
    </div>
  `;
  return row;
}

function renderTimeGroup(time, group, di){
  const wrap = document.createElement("div");
  wrap.className = "event group";

  const header = document.createElement("div");
  header.style.display = "flex";
  header.style.alignItems = "center";
  header.style.gap = "10px";
  header.innerHTML = `
    <div class="time-badge">${fmtTime12(time)}</div>
    <div class="ev-title">Options for this time</div>
    <span style="margin-left:auto" class="add-option-chip" onclick="openAddEvent(${di}, '${time}')">+ Add option</span>
  `;
  wrap.appendChild(header);

  const opts = document.createElement("div");
  opts.className = "options";

  group.forEach(({ev, ei})=>{
    const canManage = canManageEvent(ev);
    const myVote = getMyVote(ev);
    const opt = document.createElement("div");
    opt.className = "option";
    opt.innerHTML = `
      <div>
        <div style="font-weight:700">${escapeHTML(ev.title || "(Untitled)")}</div>
        ${ev.desc ? `<div class="ev-desc">${escapeHTML(ev.desc)}</div>` : ""}
        ${renderMeta(ev)}
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="btn vote up ${myVote==='u'?'selected':''}" onclick="voteEvent(${di},${ei},1)">
          👍 <span class="count" onclick="showVoters(${di},${ei},event)">${Number(ev.ups||0)}</span>
        </button>
        <button class="btn vote down ${myVote==='d'?'selected':''}" onclick="voteEvent(${di},${ei},-1)">
          👎 <span class="count" onclick="showVoters(${di},${ei},event)">${Number(ev.downs||0)}</span>
        </button>
        <div class="kebab" style="position:relative;">
          <button aria-label="menu" onclick="toggleMenu(this)">⋮</button>
          <div class="menu">
            ${(isCreator(ev) || _isAdmin) ? `<button onclick="startEditEvent(${di},${ei})">Edit</button>` : ``}
            ${canManage ? `<button onclick="deleteEvent(${di},${ei})">Delete</button>` : ``}
          </div>
        </div>
      </div>
    `;
    opts.appendChild(opt);
  });

  wrap.appendChild(opts);
  return wrap;
}

function renderMeta(ev){
  const bits = [];
  if (ev.location) bits.push(escapeHTML(ev.location));
  if (ev.link) bits.push(`<a href="${escapeAttr(ev.link)}" target="_blank" rel="noopener">link</a>`);
  if (ev.creator) bits.push(`by ${escapeHTML(ev.creator)}`);
  return bits.length ? `<div class="ev-meta">${bits.join(" · ")}</div>` : "";
}

function getMyVote(ev){
  const vu = ev.vote_users || {};
  return vu[_me] || null; // 'u' | 'd' | null
}

function isCreator(ev){
  return _me && _me === (ev.creator || "");
}

/*
  Anyone can delete when EVERY non-creator user has 👎.
  UI approximation: show button when 👎 ≥ (participants − 1).
  (Server enforces exact per-user check.)
*/
function canManageEvent(ev){
  const downs = Number(ev.downs || 0);
  const threshold = Math.max(0, (_meta.participants || 0) - 1);
  return _isAdmin || isCreator(ev) || (downs >= threshold);
}

/* ——— Voters dialog ——— */
function ensureVotersModal(){
  if (!document.getElementById("votersDlg")){
    const dlg = document.createElement("dialog");
    dlg.id = "votersDlg";
    dlg.className = "modal";
    dlg.innerHTML = `
      <div class="form">
        <h3>Votes</h3>
        <div id="votersContent" style="font-size:14px;"></div>
        <div class="row gap">
          <button class="btn primary" onclick="closeVotersDlg()">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(dlg);
  }
}
function showVoters(di, ei, evClick){
  evClick && evClick.stopPropagation();
  ensureVtersModalSafe(); // alias safety
  const ev = (_data.days[di].events || [])[ei];
  const vu = ev.vote_users || {};
  const ups = Object.keys(vu).filter(u => vu[u]==='u').sort();
  const dns = Object.keys(vu).filter(u => vu[u]==='d').sort();
  const threshold = Math.max(0, (_meta.participants || 0) - 1);

  const content = document.getElementById("votersContent");
  if (!content) { console.warn("votersContent not found"); return; }
  content.innerHTML = `
    <div><strong>👍 Upvotes (${ups.length})</strong><br>${ups.length? ups.join(", ") : "<em>none</em>"}</div>
    <div style="margin-top:8px;"><strong>👎 Downvotes (${dns.length})</strong><br>${dns.length? dns.join(", ") : "<em>none</em>"}</div>
    <div style="margin-top:10px; font-size:12px; color:#6B7280;">
      Delete unlocks for everyone when <em>all non-creator users</em> have downvoted (≈ ${threshold} needed).
    </div>
  `;
  const dlg = document.getElementById("votersDlg");
  dlg && dlg.showModal();
}
// Back-compat typo guard
function ensureVtersModalSafe(){ ensureVotersModal(); }
function closeVotersDlg(){
  const dlg = document.getElementById("votersDlg");
  dlg && dlg.close();
}

/* ——— Menus ——— */
function toggleMenu(btn){
  const menu = btn.nextElementSibling;
  const open = menu.classList.contains("open");
  closeAllMenus();
  if (!open) {
    menu.classList.add("open");
    menu.style.left = "auto";
    menu.style.right = "0";
    menu.style.top = "40px";
    menu.style.bottom = "auto";
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      if (r.right > vw) { menu.style.right = "auto"; menu.style.left = "0"; }
      if (r.bottom > vh) { menu.style.top = "auto"; menu.style.bottom = "40px"; }
    });
  }
  event.stopPropagation();
}
function closeAllMenus(){
  document.querySelectorAll(".menu.open").forEach(m => m.classList.remove("open"));
}

/* ——— Add / Edit Event ——— */
function openAddEvent(di, presetTime){
  currentDayIndex = di;
  editEventIndices = null;
  document.getElementById("dlgTitle").textContent = "Add Event";
  document.getElementById("f-time").value = presetTime || "";
  document.getElementById("f-title").value = "";
  document.getElementById("f-desc").value = "";
  document.getElementById("f-location").value = "";
  document.getElementById("f-link").value = "";
  document.getElementById("eventDlg").showModal();
}
function closeEventDlg(){ document.getElementById("eventDlg").close(); }

function startEditEvent(di, ei){
  currentDayIndex = di;
  editEventIndices = {di, ei};
  const ev = (_data.days[di].events || [])[ei];
  if (!(isCreator(ev) || _isAdmin)) { alert("Only the creator or an admin can edit this."); return; }
  document.getElementById("dlgTitle").textContent = "Edit Event";
  document.getElementById("f-time").value = ev.time || "";
  document.getElementById("f-title").value = ev.title || "";
  document.getElementById("f-desc").value = ev.desc || "";
  document.getElementById("f-location").value = ev.location || "";
  document.getElementById("f-link").value = ev.link || "";
  document.getElementById("eventDlg").showModal();
}

document.getElementById("eventForm").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const payload = {
    time: document.getElementById("f-time").value,
    title: document.getElementById("f-title").value,
    desc: document.getElementById("f-desc").value,
    location: document.getElementById("f-location").value,
    link: document.getElementById("f-link").value
  };
  if (editEventIndices){
    const res = await fetch(`/api/day/${editEventIndices.di}/event/${editEventIndices.ei}`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    if (!res.ok){
      const j = await res.json().catch(()=>({}));
      alert(j.error || "Edit not allowed.");
    }
  } else {
    await fetch(`/api/day/${currentDayIndex}/event`, {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
  }
  closeEventDlg();
});

/* ——— Votes & Deletes ——— */
async function voteEvent(di, ei, delta){
  const res = await fetch(`/api/day/${di}/event/${ei}/vote`, {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({delta})
  });
  if (!res.ok){
    const j = await res.json().catch(()=>({}));
    alert(j.error || "Vote not accepted.");
  }
}
async function deleteEvent(di, ei){
  const res = await fetch(`/api/day/${di}/event/${ei}/delete`, { method:"POST" });
  if (!res.ok){
    const j = await res.json().catch(()=>({}));
    const msg = j.error === "delete blocked"
      ? `Needs downvotes from every non-creator user. Current 👎 ${j.downs_count ?? "?"}/${j.required_count ?? "?"}.`
      : (j.error || "Delete not allowed.");
    alert(msg);
  }
}

/* ——— Helpers ——— */
function fmtDate(d){
  const [y,m,da] = d.split("-").map(Number);
  return `${m}/${da}/${String(y).slice(2)}`;
}
function fmtTime12(t){
  if (!t) return "--:--";
  const [H,M] = t.split(":").map(Number);
  if (isNaN(H)||isNaN(M)) return t;
  const ampm = H >= 12 ? "PM" : "AM";
  const h = ((H + 11) % 12) + 1;
  return `${h}:${String(M).padStart(2,"0")} ${ampm}`;
}
function timeKey(t){
  if (!t) return 24*60+1;
  const [H,M] = t.split(":").map(Number);
  if (isNaN(H)||isNaN(M)) return 24*60+1;
  return H*60+M;
}
function escapeHTML(s){ return (s||"").replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s){ return escapeHTML(s); }
