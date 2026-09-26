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
  const text = String(value || "");
  if (text.length < 18) return text || "-";
  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

function pknFromAmount(amount) {
  return `${amount ?? 0} PKN`;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text == null ? "" : String(text);
  return node;
}

function appendBlockRow(parent, block) {
  const row = document.createElement("div");
  row.className = "row";
  row.append(
    textNode("strong", "", `#${block?.number ?? ""}`),
    textNode("span", "hash", shortHash(block?.hash)),
    textNode("span", "", `${block?.transactionCount ?? 0} tx`),
  );
  parent.append(row);
}

function appendTxRow(parent, tx) {
  const row = document.createElement("div");
  row.className = "row";
  row.append(
    textNode("strong", "", pknFromAmount(tx?.amount)),
    textNode("span", "hash", shortHash(tx?.hash)),
    textNode("span", "", `#${tx?.blockNumber ?? ""}`),
  );
  parent.append(row);
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
  const blocks = el("blocks");
  clear(blocks);
  for (const block of data.blocks || []) appendBlockRow(blocks, block);
}

async function search(query) {
  const result = el("result");
  result.classList.remove("hidden");
  clear(result);
  result.append(textNode("p", "muted", "Searching..."));
  try {
    const data = await getJSON(`/explorer/search?q=${encodeURIComponent(query)}`);
    clear(result);
    if (data.type === "transaction") {
      result.append(textNode("h2", "", "Transaction"));
      appendTxRow(result, data.result);
      return;
    }
    if (data.type === "block") {
      result.append(textNode("h2", "", "Block"));
      appendBlockRow(result, data.result);
      return;
    }
    if (data.type === "address") {
      result.append(textNode("h2", "", "Address"));
      result.append(textNode("p", "hash", data.result?.address || ""));
      result.append(textNode(
        "p",
        "",
        `${pknFromAmount(data.result?.balance)} · ${data.result?.transactionCount ?? 0} tx`,
      ));
      const list = document.createElement("div");
      list.className = "list";
      for (const tx of data.result?.transactions || []) appendTxRow(list, tx);
      result.append(list);
      return;
    }
    result.append(textNode("p", "", "No result found."));
  } catch (_) {
    clear(result);
    const line = textNode("p", "", "No result found for ");
    line.append(textNode("code", "", query));
    line.append(document.createTextNode("."));
    result.append(line);
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
  const blocks = el("blocks");
  clear(blocks);
  blocks.append(textNode("p", "muted", `Explorer API unavailable: ${error.message}`));
});
