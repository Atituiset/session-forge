const $ = (id) => document.getElementById(id);
const fmt = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (s, n = 28) => s.length > n ? `…${s.slice(-n + 1)}` : s;
const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:4177";
// NOTE: Tauri injects a non-configurable `window.isTauri` global — a
// top-level `const isTauri` here would be a SyntaxError ("already declared")
// and kill the whole script. Use a different name.
const hasTauriBridge = typeof window.__TAURI_INTERNALS__ !== "undefined";
let engineOnline = false;

/* ── 窗口控制：最小化 / 放大 / X=最小化到托盘 ── */
// Tauri v2: the withGlobalTauri bundle (window.__TAURI__) can fail to inject
// on some WebView2 setups, leaving every titlebar button dead. Bind through
// __TAURI_INTERNALS__.invoke (always present inside the webview) and fall
// back to the global API only if internals is missing.
function tauriWindowInvoke(cmd) {
  const internals = window.__TAURI_INTERNALS__;
  if (internals?.invoke) {
    // Tauri v2 core window plugin commands are namespaced plugin:window|<cmd>.
    return () => internals.invoke(`plugin:window|${cmd}`, { label: "main" });
  }
  const api = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!api) return null;
  const map = { minimize: () => api.minimize(), toggle_maximize: () => api.toggleMaximize(), hide: () => api.hide() };
  return map[cmd] ?? null;
}

if (hasTauriBridge) {
  const minFn = tauriWindowInvoke("minimize");
  const maxFn = tauriWindowInvoke("toggle_maximize");
  const hideFn = tauriWindowInvoke("hide");
  if (minFn && maxFn && hideFn) {
    $("btn-min").onclick = minFn;
    $("btn-max").onclick = maxFn;
    $("btn-close").onclick = hideFn;
  } else {
    console.error("window controls unavailable: no tauri IPC bridge");
    document.querySelector(".winbtns").style.display = "none";
  }
} else {
  document.querySelector(".winbtns").style.display = "none";
}


function setPill(ok, text) {
  engineOnline = ok;
  const pill = $("engine-pill");
  pill.classList.toggle("offline", !ok);
  // Offline on the desktop app: sidecar stdout/stderr lands in this log.
  pill.title = ok ? "" : "引擎未响应 · 日志见 ~/.session-forge/engine.log";
  $("engine-pill-text").textContent = text;
  $("btn-scan").disabled = !ok;
}

async function checkEngine() {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    setPill(true, j.scanning ? "ENGINE · 扫描中" : "ENGINE ONLINE · 本地数据");
    return true;
  } catch {
    setPill(false, "ENGINE OFFLINE · 引擎未响应");
    return false;
  }
}

async function loadData() {
  const d = await (await fetch(`${API}/api/data`)).json();
  render(d);
}

function render(d) {
  const t = d.totals;
  $("metrics").innerHTML = [
    ["Sessions", fmt(t.sessions), `${t.projects} 个项目`],
    ["交互轮次", fmt(t.rounds), "user → assistant 往返"],
    ["代码变更", `+${fmt(t.additions)}`, `-${fmt(t.deletions)} 行`],
    ["Token 消耗", fmt(t.tokensIn), `out ${fmt(t.tokensOut)}`],
  ].map(([l, v, s]) =>
    `<div class="card metric"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`
  ).join("");

  const maxAct = Math.max(...d.activity.map((a) => a.sessions), 1);
  $("activity").innerHTML = d.activity.slice(-14).map((a) =>
    `<div class="bar-row"><span class="name">${a.bucket}</span>
     <div class="bar-track"><div class="bar-fill" style="width:${((a.sessions / maxAct) * 100).toFixed(1)}%"></div></div>
     <span class="num">${a.sessions}</span></div>`
  ).join("") || `<p style="color:var(--dim)">暂无数据，点击右上角扫描。</p>`;

  $("projects").innerHTML =
    `<tr><th>项目</th><th>来源</th><th style="text-align:right">会话</th><th style="text-align:right">变更</th><th style="text-align:right">Tokens</th></tr>` +
    d.projects.map((p) =>
      `<tr><td>${esc(p.project)}</td><td><span class="chip">${esc(p.source)}</span></td>
       <td class="num">${p.sessions}</td><td class="num" style="color:var(--green)">+${fmt(p.additions)}</td>
       <td class="num">${fmt(p.tokensIn)}</td></tr>`
    ).join("");

  renderDonut(d.models);

  const maxF = Math.max(...d.topFiles.map((f) => f.count), 1);
  $("files").innerHTML = d.topFiles.slice(0, 8).map((f) =>
    `<div class="bar-row"><span class="name" title="${esc(f.file)}">${esc(short(f.file))}</span>
     <div class="bar-track"><div class="bar-fill" style="width:${((f.count / maxF) * 100).toFixed(1)}%"></div></div>
     <span class="num">${f.count}</span></div>`
  ).join("");

  $("blackholes").innerHTML =
    `<tr><th>来源</th><th>项目</th><th style="text-align:right">轮次</th></tr>` +
    d.blackholes.map((b) =>
      `<tr><td><span class="chip">${esc(b.source)}</span></td>
       <td title="${esc(b.id)}">${esc(short(b.project || b.id, 26))}</td>
       <td class="num flame" style="text-align:right;font-family:var(--mono);color:var(--amber)">${b.rounds} ⟳</td></tr>`
    ).join("");

  $("foot").textContent = `SESSIONFORGE ENGINE · ${d.generatedAt.replace("T", " ").slice(0, 19)} · 本地数据 · 未联网`;
}

function renderDonut(models) {
  const colors = ["#22d3ee", "#a78bfa", "#fbbf24", "#34d399", "#fb7185", "#60a5fa", "#f472b6"];
  const total = models.reduce((s, m) => s + m.tokensIn, 0) || 1;
  let angle = -Math.PI / 2;
  const cx = 62, cy = 62, r = 46, sw = 16;
  let paths = "";
  models.slice(0, 7).forEach((m, i) => {
    const frac = m.tokensIn / total;
    const a0 = angle, a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    if (frac > 0.999) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="${sw}"/>`;
    } else {
      paths += `<path d="M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    }
  });
  const legend = models.slice(0, 7).map((m, i) =>
    `<span><i style="background:${colors[i % colors.length]}"></i>${esc(m.model)}<b>${fmt(m.tokensIn)}</b></span>`
  ).join("");
  $("models-donut").innerHTML =
    `<svg width="124" height="124" style="filter:drop-shadow(0 0 12px rgba(34,211,238,.25))">
       <circle cx="62" cy="62" r="46" fill="none" stroke="rgba(120,160,255,.08)" stroke-width="16"/>${paths}
       <text x="62" y="58" text-anchor="middle" fill="#dbe4ff" font-size="13" font-family="var(--mono)" font-weight="600">${models.length}</text>
       <text x="62" y="74" text-anchor="middle" fill="#7c8db5" font-size="9">模型</text>
     </svg><div class="legend">${legend}</div>`;
}

/* ── 本地扫描：POST 是异步 job（202），轮询 /api/scan/status 直到完成 ── */
let scanTimer = null;
async function pollScanDone(btn) {
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    let st;
    try {
      st = await (await fetch(`${API}/api/scan/status`, { signal: AbortSignal.timeout(3000) })).json();
    } catch {
      continue;
    }
    $("toast-msg").textContent = `正在扫描本机 Agent… ${(Date.now() - t0) / 1000 | 0}s`;
    if (st.status !== "running") return st;
  }
}

async function runScan() {
  if (!engineOnline) return;
  const btn = $("btn-scan");
  btn.disabled = true;
  $("toast").classList.add("show");
  $("toast-spin").style.display = "block";
  try {
    const res = await fetch(`${API}/api/scan`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("toast-spin").style.display = "none";
      $("toast-msg").textContent =
        res.status === 409 ? "已有扫描在进行中…" : `触发扫描失败：${j.error ?? res.status}`;
      return;
    }
    // 202 {status:"started"} — poll until the job finishes.
    const done = await pollScanDone(btn);
    $("toast-spin").style.display = "none";
    const sum = done?.summary;
    $("toast-msg").textContent = done?.status === "ok" && sum
      ? `扫描完成 · ${(sum.durationMs / 1000).toFixed(1)}s · ${sum.tools.filter((t) => t.sessions > 0).length} 个数据源 · 共 ${sum.tools.reduce((s2, t) => s2 + t.sessions, 0)} 会话`
      : `扫描失败：${done?.error ?? "未知错误"}`;
    await loadData();
  } catch (e) {
    $("toast-spin").style.display = "none";
    $("toast-msg").textContent = "引擎未响应，请重启应用";
  } finally {
    setTimeout(() => {
      $("toast").classList.remove("show");
      $("toast-msg").textContent = "扫描中…";
      $("toast-spin").style.display = "block";
      btn.disabled = !engineOnline;
    }, 2600);
  }
}

/* ── 远程机器管理（多台 + 密码认证） ── */
async function loadRemotes() {
  try {
    const j = await (await fetch(`${API}/api/remotes`)).json();
    const el = $("remotes");
    $("remote-count").textContent = j.remotes.length ? `${j.remotes.length} 台` : "";
    if (!j.remotes.length) {
      el.innerHTML = `<div class="remote-empty">尚未添加远程机器 · 点击上方「添加远程机器」</div>`;
      return;
    }
    el.innerHTML = j.remotes.map((r) => {
      const job = r.job;
      let dot = "", status = `<span class="sub">等待扫描${r.hasPassword ? " · 已存密码凭证" : ""}</span>`;
      if (job?.status === "running") {
        dot = ` run`;
        status = `<span class="chip run">扫描中 ${((Date.now() - job.startedAt) / 1000 | 0)}s</span>`;
      } else if (job?.status === "ok") {
        dot = ` ok`;
        status = `<span class="chip ok">完成 · ${esc(String(job.summary ?? ""))} 个数据源 · ${new Date(job.finishedAt).toLocaleTimeString()}</span>`;
      } else if (job?.status === "error") {
        dot = ` err`;
        status = `<span class="chip err" title="${esc(job.error)}">失败：${esc(short(job.error ?? "", 40))}</span>`;
      }
      const running = job?.status === "running";
      const display = r.username ? `${esc(r.username)}@${esc(r.host)}` : esc(r.host);
      return `<div class="remote-row">
        <span class="dot${dot}"></span>
        <div class="meta">
          <span class="host" title="${display}">${display}</span>
          ${status}
        </div>
        <button class="mini-btn" type="button" data-scan="${esc(r.name)}" ${running ? "disabled" : ""}>扫描</button>
        <button class="mini-btn danger" type="button" data-del="${esc(r.name)}">删除</button>
      </div>`;
    }).join("");
    el.querySelectorAll("[data-scan]").forEach((b) =>
      b.onclick = async () => {
        b.disabled = true;
        await fetch(`${API}/api/remotes/${encodeURIComponent(b.dataset.scan)}/scan`, { method: "POST" });
        setTimeout(loadRemotes, 400);
      });
    el.querySelectorAll("[data-del]").forEach((b) =>
      b.onclick = async () => {
        await fetch(`${API}/api/remotes/${encodeURIComponent(b.dataset.del)}`, { method: "DELETE" });
        loadRemotes();
      });
  } catch {}
}

$("btn-remote-add").onclick = async () => {
  const hostEl = $("remote-host"), userEl = $("remote-user"), passEl = $("remote-pass");
  const host = hostEl.value.trim();
  if (!host) { hostEl.focus(); return; }
  // API still keys on `name`; pass user@host as name so list stays unique per host.
  const user = userEl.value.trim();
  const name = user && !host.includes("@") ? `${user}@${host}` : host;
  const res = await fetch(`${API}/api/remotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      username: user || undefined,
      password: passEl.value || undefined,
    }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    alert(j.error ?? "添加失败");
    return;
  }
  hostEl.value = ""; userEl.value = ""; passEl.value = "";
  $("remote-form-box").removeAttribute("open");
  loadRemotes();
};

/* ── 从 ~/.ssh/config 导入远端机器 ── */
$("btn-ssh-import").onclick = async () => {
  const btn = $("btn-ssh-import");
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/api/remotes/import-ssh`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    btn.textContent = j.added > 0 ? `已导入 ${j.added} 台` : "没有新的主机";
    setTimeout(() => { btn.textContent = "从 ~/.ssh/config 导入"; btn.disabled = false; }, 2000);
    loadRemotes();
  } catch {
    btn.textContent = "导入失败";
    setTimeout(() => { btn.textContent = "从 ~/.ssh/config 导入"; btn.disabled = false; }, 2000);
  }
};

/* ── 会话浏览：列表 + 详情浮层 ── */
const sessionsQuery = { q: "", source: "", offset: 0 };
let sessionsTotal = 0;
let lastSessionRows = [];
const knownSources = [];
let openSession = null;
const SESSION_PAGE = 50;

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function loadSessions() {
  const params = new URLSearchParams({ limit: String(SESSION_PAGE), offset: String(sessionsQuery.offset) });
  if (sessionsQuery.q) params.set("q", sessionsQuery.q);
  if (sessionsQuery.source) params.set("source", sessionsQuery.source);
  try {
    const j = await (await fetch(`${API}/api/sessions?${params}`)).json();
    renderSessions(j);
  } catch {}
}

function renderSessions(j) {
  const list = j.sessions ?? [];
  lastSessionRows = list;
  sessionsTotal = j.total ?? list.length;
  $("session-count").textContent = sessionsTotal ? `${sessionsTotal}` : "";
  const sel = $("session-source");
  const prev = sel.value;
  for (const s of list) if (!knownSources.includes(s.source)) knownSources.push(s.source);
  sel.innerHTML = `<option value="">全部来源</option>` +
    knownSources.map((s) => `<option value="${esc(s)}"${s === prev ? " selected" : ""}>${esc(s)}</option>`).join("");
  const el = $("sessions");
  if (!list.length) {
    el.innerHTML = `<div class="remote-empty">没有匹配的会话</div>`;
  } else {
    el.innerHTML = list.map((s) => `<div class="session-row" data-source="${esc(s.source)}" data-id="${esc(s.id)}">
      <span class="chip">${esc(s.source)}</span>
      <div class="meta">
        <span class="proj" title="${esc(s.projectPath || s.id)}">${esc(short(s.projectPath || s.id, 40))}</span>
        <span class="sub">${fmtTime(s.startedAt)}${s.endedAt ? ` → ${fmtTime(s.endedAt)}` : ""}</span>
      </div>
      <div class="stats">${s.rounds} 轮<b>${fmt(s.tokensIn)} tok</b></div>
    </div>`).join("");
    el.querySelectorAll(".session-row").forEach((r) => {
      r.onclick = () => openSessionDetail(r.dataset.source, r.dataset.id);
    });
  }
  $("session-prev").disabled = sessionsQuery.offset <= 0;
  $("session-next").disabled = sessionsQuery.offset + SESSION_PAGE >= sessionsTotal;
  $("session-page-info").textContent = sessionsTotal
    ? `${sessionsQuery.offset + 1}–${Math.min(sessionsQuery.offset + SESSION_PAGE, sessionsTotal)} / ${sessionsTotal}`
    : "";
}

async function openSessionDetail(source, id) {
  openSession = { source, id };
  $("session-overlay").classList.add("show");
  $("session-detail").innerHTML =
    `<div class="sess-head"><div class="spinner"></div><span style="color:var(--dim)">加载会话…</span></div>`;
  await refreshSessionDetail();
}

async function refreshSessionDetail() {
  if (!openSession) return;
  const { source, id } = openSession;
  try {
    const res = await fetch(`${API}/api/session?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`);
    if (res.status === 404) { closeSessionDetail(); return; }
    const j = await res.json();
    // The user may have closed or switched sessions while fetching.
    if (!openSession || openSession.source !== source || openSession.id !== id) return;
    renderSessionDetail(j);
  } catch {}
}

function closeSessionDetail() {
  openSession = null;
  $("session-overlay").classList.remove("show");
}

const pretty = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

const longPre = (text) => {
  const t = text ?? "";
  if (t.length <= 2000) return `<pre>${esc(t)}</pre>`;
  return `<pre>${esc(t.slice(0, 2000))}…</pre>
    <details class="expand"><summary>展开全部</summary><pre>${esc(t)}</pre></details>`;
};

function renderMsg(m) {
  const when = m.timestamp ? `<time>${fmtTime(m.timestamp)}</time>` : "";
  if (m.role === "system") {
    return `<div class="msg system">${esc(short(m.content ?? "", 300))}</div>`;
  }
  if (m.role === "tool") {
    return `<div class="msg tool"><details>
      <summary>工具 · ${esc(m.toolName ?? "tool")}${m.timestamp ? ` · ${fmtTime(m.timestamp)}` : ""}</summary>
      ${m.toolInput != null ? longPre(pretty(m.toolInput)) : ""}
      ${m.content ? longPre(m.content) : ""}
    </details></div>`;
  }
  const thinking = m.thinking
    ? `<details class="thinking"><summary>思考过程</summary><pre>${esc(m.thinking)}</pre></details>`
    : "";
  return `<div class="msg ${m.role === "user" ? "user" : "assistant"}">
    <div class="who">${m.role === "user" ? "USER" : `ASSISTANT${m.model ? ` · ${esc(m.model)}` : ""}`}${when}</div>
    ${thinking}
    ${m.content ? `<div class="body">${esc(m.content)}</div>` : ""}
  </div>`;
}

function renderSessionDetail(j) {
  const row = lastSessionRows.find((s) => s.source === j.source && s.id === j.id);
  const stats = row
    ? `<b>${fmt(row.tokensIn)}</b> in · <b>${fmt(row.tokensOut)}</b> out · <b>${row.rounds}</b> 轮`
    : `<b>${(j.messages ?? []).length}</b> 条消息`;
  const head = `<div class="sess-head">
    <span class="chip">${esc(j.source)}</span>
    <span class="proj" title="${esc(j.projectPath || j.id)}">${esc(short(j.projectPath || j.id, 56))}</span>
    <span class="stats">${fmtTime(j.startedAt)}${j.endedAt ? ` → ${fmtTime(j.endedAt)}` : ""} · ${stats}</span>
    <button class="mini-btn sess-close" type="button" id="session-close">关闭 ✕</button>
  </div>`;
  const body = (j.messages ?? []).map(renderMsg).join("") || `<div class="remote-empty">此会话没有消息</div>`;
  const panel = $("session-detail");
  const st = panel.scrollTop;
  panel.innerHTML = head + body;
  panel.scrollTop = st;
  $("session-close").onclick = closeSessionDetail;
}

let searchTimer = null;
$("session-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    sessionsQuery.q = $("session-search").value.trim();
    sessionsQuery.offset = 0;
    loadSessions();
  }, 300);
});
$("session-source").onchange = () => {
  sessionsQuery.source = $("session-source").value;
  sessionsQuery.offset = 0;
  loadSessions();
};
$("session-prev").onclick = () => {
  sessionsQuery.offset = Math.max(0, sessionsQuery.offset - SESSION_PAGE);
  loadSessions();
};
$("session-next").onclick = () => {
  if (sessionsQuery.offset + SESSION_PAGE < sessionsTotal) {
    sessionsQuery.offset += SESSION_PAGE;
    loadSessions();
  }
};
$("session-overlay").addEventListener("click", (e) => {
  if (e.target === $("session-overlay")) closeSessionDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openSession) closeSessionDetail();
});

$("btn-scan").onclick = runScan;
$("btn-export").onclick = () => window.open(`${API}/api/data`, "_blank");

if (hasTauriBridge) {
  const internals = window.__TAURI_INTERNALS__;
  const listen = internals?.invoke && internals?.transformCallback
    ? (event, cb) => {
        const handler = internals.transformCallback((e) => cb(e.payload ?? e));
        return internals.invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler }).then(() => {});
      }
    : window.__TAURI__?.event.listen;
  listen?.("trigger-scan", () => runScan());
}

(async function boot() {
  const online = await checkEngine();
  if (online) {
    loadData().catch(() => {});
    loadRemotes();
    loadSessions();
    // First launch (or empty db): kick off an automatic scan so the panel
    // is never a wall of empty cards.
    try {
      const d = await (await fetch(`${API}/api/data`, { signal: AbortSignal.timeout(5000) })).json();
      if ((d.totals?.sessions ?? 0) === 0) {
        runScan();
      }
    } catch {}
  }
})();
setInterval(checkEngine, 5000);
setInterval(loadData, 30000);
setInterval(() => { if (engineOnline) loadRemotes(); }, 3000);
// Sessions refresh: skip the list while the user is typing in the search box;
// live-update the open detail view so an actively-growing session stays fresh.
setInterval(() => {
  if (!engineOnline) return;
  if (document.activeElement !== $("session-search")) loadSessions();
  if (openSession) refreshSessionDetail();
}, 15000);
