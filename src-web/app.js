const $ = (id) => document.getElementById(id);
const fmt = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const short = (s, n = 28) => s.length > n ? `…${s.slice(-n + 1)}` : s;
const API = new URLSearchParams(location.search).get("api") ?? "http://127.0.0.1:4177";
const isTauri = typeof window.__TAURI_INTERNALS__ !== "undefined";
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

if (isTauri) {
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

$("btn-scan").onclick = runScan;
$("btn-export").onclick = () => window.open(`${API}/api/data`, "_blank");

if (isTauri) {
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
