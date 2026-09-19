const API_BASE = window.POKOINPOS_API_BASE || "https://rpc.pokoin.com";

const el = (id) => document.getElementById(id);

async function getJSON(path) {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function shortHash(value) {
  if (!value || value.length < 18) return value || "-";
  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function pknFromAmount(amount) {
  return `${amount ?? 0} PKN`;
}

function blockRow(block) {
  return `
    <div class="row">
      <strong>#${block.number}</strong>
      <span class="hash">${shortHash(block.hash)}</span>
      <span>${block.transactionCount} tx</span>
    </div>
  `;
}

function txRow(tx) {
  return `
    <div class="row">
      <strong>${pknFromAmount(tx.amount)}</strong>
      <span class="hash">${shortHash(tx.hash)}</span>
      <span>#${tx.blockNumber}</span>
    </div>
  `;
}

async function loadStatus() {
  const status = await getJSON("/chain/status");
  el("height").textContent = status.height;
  el("committed").textContent = status.committedHeight;
  el("tx-count").textContent = status.txCount;
  el("mempool").textContent = status.mempoolDepth;
}

async function loadBlocks() {
  const data = await getJSON("/explorer/blocks?limit=12");
  el("blocks").innerHTML = data.blocks.map(blockRow).join("");
}

async function search(query) {
  const result = el("result");
  result.classList.remove("hidden");
  result.innerHTML = "<p class=\"muted\">Searching...</p>";
  try {
    const data = await getJSON(`/explorer/search?q=${encodeURIComponent(query)}`);
    if (data.type === "transaction") {
      result.innerHTML = `<h2>Transaction</h2>${txRow(data.result)}`;
      return;
    }
    if (data.type === "block") {
      result.innerHTML = `<h2>Block</h2>${blockRow(data.result)}`;
      return;
    }
    if (data.type === "address") {
      const txs = (data.result.transactions || []).map(txRow).join("");
      result.innerHTML = `
        <h2>Address</h2>
        <p class="hash">${data.result.address}</p>
        <p>${pknFromAmount(data.result.balance)} · ${data.result.transactionCount} tx</p>
        <div class="list">${txs}</div>
      `;
      return;
    }
    result.innerHTML = "<p>No result found.</p>";
  } catch (error) {
    result.innerHTML = `<p>No result found for <code>${query}</code>.</p>`;
  }
}

async function refresh() {
  await Promise.all([loadStatus(), loadBlocks()]);
}

el("refresh").addEventListener("click", refresh);
el("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = el("search-input").value.trim();
  if (query) search(query);
});

refresh().catch((error) => {
  el("blocks").innerHTML = `<p class="muted">Explorer API unavailable: ${error.message}</p>`;
});
