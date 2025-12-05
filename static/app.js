// Kanban Board – FULL WORKING VERSION

// ===== Toast helper (insert near top of app.js) =====
(function createToastContainer(){
  if (!document.querySelector('.toast-wrap')) {
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
})();

function showToast(message, type="info", timeout=3000){
  const wrap = document.querySelector('.toast-wrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<div class="icon">${type==='success'?'✓':type==='error'?'⚠':'i'}</div><div class="msg">${message}</div>`;
  wrap.prepend(t);
  // force reflow then show
  requestAnimationFrame(()=> t.classList.add('show'));
  // remove after timeout
  setTimeout(()=>{
    t.classList.remove('show');
    setTimeout(()=> t.remove(), 220);
  }, timeout);
}


const columns = [
  { key: "todo", title: "To Do" },
  { key: "in-progress", title: "In Progress" },
  { key: "done", title: "Done" }
];

const boardEl = document.getElementById('board');
const newTitle = document.getElementById('newTitle');
const addBtn = document.getElementById('addBtn');

let cards = [];
let sortables = {};
let currentEdit = null;

// ------------------ FETCH CARDS -----------------------
async function fetchCards(){
  try {
    const res = await fetch('/api/cards');
    cards = await res.json();
    renderBoard();
  } catch (err) {
    console.error("Error loading cards:", err);
    boardEl.innerHTML = "<p style='color:red'>Unable to load board.</p>";
  }
}

// ------------------ RENDER BOARD ----------------------
function renderBoard(){
  // clear board
  boardEl.innerHTML = "";

  columns.forEach(col => {
    const colEl = document.createElement("div");
    colEl.className = "column";
    colEl.dataset.col = col.key;

    const head = document.createElement("div");
    head.className = "col-head";
    head.innerHTML = `<h3>${col.title} <small>(${cards.filter(c => c.status === col.key).length})</small></h3>`;
    colEl.appendChild(head);

    const list = document.createElement("div");
    list.className = "list";
    list.id = `list-${col.key}`;

    // highlight column while dragging over it
    list.addEventListener('dragenter', () => colEl.classList.add('drag-over'));
    list.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    list.addEventListener('drop', () => colEl.classList.remove('drag-over'));

    // append cards for this column sorted by order_idx
    const colCards = cards
      .filter(c => c.status === col.key)
      .sort((a,b) => (a.order_idx||0) - (b.order_idx||0));

    colCards.forEach(c => {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.id = c.id;

      // ensure priority normalized to 'high'|'medium'|'low'
      let prRaw = (c.priority || "medium").toString().toLowerCase();
      let pr = (prRaw === "high" || prRaw === "low") ? prRaw : "medium";
      const badgeText = pr === "high" ? "HIGH" : pr === "low" ? "LOW" : "MED";

      card.innerHTML = `
        <div class="card-head">
          <span class="badge badge-${pr}">${badgeText}</span>
          <div class="title">${escapeHtml(c.title)}</div>
        </div>
        <div class="meta">${c.due_date ? "• due " + escapeHtml(c.due_date) : ""}</div>
      `;

      card.onclick = () => openModal(c.id);
      list.appendChild(card);
    });

    colEl.appendChild(list);
    boardEl.appendChild(colEl);

    // destroy previous sortable if exists
    if (sortables[col.key]) {
      try { sortables[col.key].destroy(); } catch(e) { /* ignore */ }
    }

    // keep your Sortable options unchanged (rest of file uses your robust block)
    // Sortable tuned for touch (replace your current options object)
// universal Sortable config — reliable on desktop + mobile
sortables[col.key] = new Sortable(list, {
  group: { name: "kanban", pull: true, put: true },
  animation: 150,
  fallbackOnBody: true,
  // USE JS fallback for max reliability across all browsers
  forceFallback: true,
  // small threshold avoids accidental drags during scroll
  touchStartThreshold: 6,
  scroll: true,
  scrollSensitivity: 30,
  scrollSpeed: 10,
  ghostClass: "sortable-ghost",
  chosenClass: "sortable-chosen",
  dragClass: "sortable-dragging",
  swapThreshold: 0.55,

  onMove: (evt) => {
    try {
      document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
      const destCol = evt.to?.closest?.('.column');
      if (destCol) destCol.classList.add('drag-over');
    } catch(e){}
    return true;
  },

  onEnd: async (evt) => {
    // always log so we can see what's happening
    console.log("Sortable onEnd:", {
      id: evt.item?.dataset?.id,
      from: evt.from?.closest(".column")?.dataset?.col,
      to: evt.to?.closest(".column")?.dataset?.col,
      oldIndex: evt.oldIndex,
      newIndex: evt.newIndex
    });
    // small safety cleanup
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
    await onDragEnd();
  },

  onChoose: () => {
    // helpful debug
    //console.log('choose');
  },
  onUnchoose: () => {
    //console.log('unchoose');
  }
});

  });
}

// ------------------ ESCAPE HTML -----------------------
function escapeHtml(txt){
  return txt.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

// ------------------ DRAG END → SAVE ORDER -------------
async function onDragEnd(){
  const orders = {};
  columns.forEach(col=>{
    const list = document.getElementById(`list-${col.key}`);
    orders[col.key] = Array.from(list.children).map(c => c.dataset.id);
  });

  console.log("Sending reorder:", orders);

  try {
    const res = await fetch('/api/reorder', {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ orders })
    });

    const text = await res.text();
    console.log('Reorder response:', res.status, text);

    if (res.ok){
      showToast('Moved ✓', 'success', 1800);
    } else {
      showToast('Move failed', 'error', 2600);
      console.error('Reorder error', text);
    }
  } catch (err) {
    console.error('Reorder network err', err);
    showToast('Network error while moving', 'error', 2600);
  }

  await fetchCards();
}

// ------------------ ADD CARD --------------------------
addBtn.onclick = async () => {
  const txt = newTitle.value.trim();
  if (!txt) return alert("Enter a title");

  try {
    const res = await fetch("/api/card", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ title: txt, status: "todo" })
    });

    if (res.ok){
      newTitle.value = "";
      showToast('Task added', 'success', 1500);
      fetchCards();
    } else {
      const t = await res.text();
      console.error('Add failed', res.status, t);
      showToast('Failed to add', 'error', 2400);
    }
  } catch (err) {
    console.error('Network error add', err);
    showToast('Network error', 'error', 2400);
  }
};


// ------------------ MODAL LOGIC ------------------------
// ------------------ MODAL LOGIC ------------------------
const modal = document.getElementById('modal');
const mTitle = document.getElementById('mTitle');
const mDesc = document.getElementById('mDesc');
const mPriority = document.getElementById('mPriority');
const mTags = document.getElementById('mTags');
const mDue = document.getElementById('mDue');
const saveBtn = document.getElementById('saveBtn');
const deleteBtn = document.getElementById('deleteBtn');
const closeBtn = document.getElementById('closeBtn');

function openModal(id){
  currentEdit = cards.find(c => c.id == id);
  if (!currentEdit) return;

  mTitle.value = currentEdit.title ?? "";
  mDesc.value = currentEdit.description ?? "";
  mPriority.value = currentEdit.priority ?? "medium";
  mTags.value = (currentEdit.tags || []).join(",");
  mDue.value = currentEdit.due_date ?? "";

  modal.classList.remove("hidden");
}

if (closeBtn) {
  closeBtn.onclick = () => {
    modal.classList.add("hidden");
    currentEdit = null;
  };
}

if (saveBtn) {
  saveBtn.onclick = async () => {
    if (!currentEdit) return;
    const payload = {
      title: mTitle.value,
      description: mDesc.value,
      priority: mPriority.value,
      tags: mTags.value.split(",").map(t => t.trim()).filter(Boolean),
      due_date: mDue.value
    };
    try {
      const res = await fetch(`/api/card/${currentEdit.id}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      if (res.ok){
        modal.classList.add('hidden');
        currentEdit = null;
        showToast('Saved ✓', 'success', 1400);
        await fetchCards();
      } else {
        const text = await res.text();
        console.error('Save failed:', res.status, text);
        showToast('Save failed', 'error', 2400);
      }
    } catch (err) {
      console.error('Network error saving card:', err);
      showToast('Network error while saving.', 'error', 2400);
    }
  };
}

if (deleteBtn) {
  deleteBtn.onclick = async () => {
    if (!currentEdit) return;
    if (!confirm('Delete this card?')) return;
    try {
      const res = await fetch(`/api/card/${currentEdit.id}`, { method: 'DELETE' });
      if (res.ok){
        modal.classList.add('hidden');
        currentEdit = null;
        showToast('Deleted ✓', 'success', 1400);
        await fetchCards();
      } else {
        const text = await res.text();
        console.error('Delete failed:', res.status, text);
        showToast('Delete failed', 'error', 2400);
      }
    } catch (err) {
      console.error('Network error deleting card:', err);
      showToast('Network error while deleting.', 'error', 2400);
    }
  };
}
// ------------------ START APP --------------------------
fetchCards();