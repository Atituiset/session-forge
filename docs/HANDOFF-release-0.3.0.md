# v0.3.0 发版交接文档

> 写于 2026-10-05 15:55 · WSL UbuntuRecover · session-forge
> 交接原因:当前 agent 在 Linux AppImage 构建上反复失败,交给 kimi 接手。

---

## 一、一句话现状

**v0.3.2 已完整发布:三平台产物 + 全部 .sig + latest.json 齐全。** Linux AppImage 根因(patchelf 破坏 bun sidecar,坑 4)和签名缺失根因(`createUpdaterArtifacts` 缺省 false)均已修复。剩余仅客户端侧实测:updater 端到端、agent 自动重部署跨机重扫、hermes 跨机。

**版本说明**:0.3.0(无 Linux、未签名)→ 0.3.1(AppImage 修复,但漏了 createUpdaterArtifacts 仍未签名)→ 0.3.2(完整)。0.3.0/0.3.1 的 release 留在原地,latest 指向 0.3.2。

---

## 二、必须先知道的三个坑(会让你重复踩)

### 坑 1:CI 只显示一句假错误

```
failed to bundle project: `failed to run linuxdeploy`
```

**tauri 把 linuxdeploy 的 stderr 吞掉了。** 这句话不含任何诊断信息。
我已经加了 preflight 步骤(`fetch linuxdeploy (preflight)`)来暴露真实原因 —— 如果它跑通了但 tauri 仍失败,说明问题在 tauri 如何 spawn 这个子进程,而不是 linuxdeploy 本身。

### 坑 2:改 `bundle.targets` 会同时干掉 macOS 和 Windows

我为了逼 Linux 出 AppImage,把 `targets` 改成 `["deb","appimage"]`,结果:
- macOS 不再构建 dmg → `No artifacts were found`
- Windows 丢失 NSIS 安装包

**`targets: "all"` 是平台感知的**(Tauri 按 host 解析各自默认集合)。不要列举。

### 坑 3:`strip = true` 与 updater 冲突

`src-tauri/Cargo.toml` 原来是 `strip = true`,已改 `false`。依据:
- Tauri 构建后要 patch `__TAURI_BUNDLE_TYPE` 标记,被 strip 掉后 updater 无法更新该包(upstream 明确警告)
- linuxdeploy 会对 AppDir 里的 .so 跑 strip,可能报 `.relr.dyn` 不识别

### 坑 4(AppImage 的真正根因,已实锤):patchelf/strip 会**摧毁** bun 编译的 sidecar

前三次失败全是这一个问题,但错误被坑 1 吞掉所以一直在猜。完整链条:

1. linuxdeploy 主阶段对 AppDir 里**每个 ELF** 跑 `patchelf --set-rpath`
2. patchelf 重写 ELF section 布局,而 `bun build --compile` 的 JS payload 是按文件偏移引用的 overlay —— **改完布局后二进制直接报废:启动即段错误,`ldd` 静默退 1(无输出)**
3. gtk 插件会**第二次**遍历 AppDir(嵌套 linuxdeploy 调用),对已被 patchelf 改坏的 engine 跑 ldd → 抛 `std::runtime_error` 中止
4. tauri 只报 `failed to run linuxdeploy`

**修复**(`scripts/linuxdeploy-patchelf.sh` + release.yml):linuxdeploy 认 `$PATCHELF` 环境变量(elf_file.cpp),指向一个选择性 wrapper —— bun sidecar(engine/agent,只链系统库,不需要 rpath)直接跳过,其余文件透传给真 patchelf;同时设 `NO_STRIP=1` 防 strip 同样破坏 overlay。**即使构建能过,不修这个 shipped AppImage 里的 engine 也是坏的** —— 这不是构建问题,是产物正确性问题。

验证方法(以后排查类似问题可复用):
- tauri-action 加 `args: --verbose` —— bundler 在 verbose 下会逐行打 linuxdeploy 的 stderr(非 verbose 直接丢弃,这就是坑 1 的机制,`tauri-bundler/src/utils/mod.rs`)
- `if: failure()` 的 postmortem 步骤:失败的构建会留下 AppDir 和 `~/.cache/tauri` 工具,原样复现 tauri 的调用,输出全可见
- 下载旧版 glibc 的 deb 解包,用它的 loader 跑 `--list`/`--verify`,可以在新系统上模拟老系统的 ldd

---

## 三、当前状态表

| 项目 | 状态 |
|---|---|
| agent-session-format 0.9.0 | ✅ 已发 npm,110 测试通过 |
| session-forge 代码 | ✅ 已推 origin/main(0.3.2,`4783a8c` + 文档更新) |
| CI(非 release) | ✅ 全绿(4 jobs × 3 OS) |
| 本地测试 | ✅ 133 通过 · lint 干净 · typecheck 干净 |
| release 0.3.2 macOS | ✅ dmg + app.tar.gz + .sig |
| release 0.3.2 Windows | ✅ NSIS + MSI + .sig,冒烟测试通过 |
| release 0.3.2 Linux | ✅ AppImage + deb + rpm + .sig(坑 4 修复) |
| `latest.json` | ✅ 已生成(createUpdaterArtifacts: true,见下) |
| updater 端到端 | ⚠️ 待实测(0.3.0 客户端 → 0.3.2) |
| agent 自动重部署跨机重扫 | ⚠️ 待实测(Windows 装 0.3.2 后) |
| hermes 跨机扫描 | ⚠️ 待实测(同上,修复见第六节) |

**第六个坑(0.3.1 踩的)**:`bundle.createUpdaterArtifacts` 缺省是 `false`(tauri-utils `Default for Updater = Bool(false)`)。配置里没这个 key 时 `settings.updater()` 为 `None`,**签名被整体静默跳过,不报错**。updater 插件 active ≠ 会签。0.3.1 全绿但零签名就是这个原因。

---

## 四、待办(按建议顺序)

### A. 先诊断 Linux(别再猜)—— **已完成,根因见坑 4**

~~用刚加的 preflight 步骤。~~ 最终生效的诊断组合:`args: --verbose` + postmortem 复现步骤(都留在 release.yml 里了)。根因不是 FUSE、不是 spawn、不是 glibc —— 是 patchelf 破坏 bun sidecar 后 gtk 插件的嵌套 linuxdeploy 对其跑 ldd 中止。参考线索的收尾:
- commit `8b465a12b` 那条确实只换了 plugin,但与本故障无关
- "APPIMAGE_EXTRACT_AND_RUN 不传播"的说法对 bundler 2.9.x 已过时(它自己设置并传 `--appimage-extract-and-run`)
- 22.04 pin 保留(没必要动),但故障与它无关

### B. 如果 Linux 短期解不了

用 `continue-on-error` 让 AppImage 失败不阻塞发布。
代价:**Linux 用户没有自动更新**(Tauri 在 Linux 上只签 AppImage),需手动下载 `.deb`。
Windows / macOS 的 updater 照常工作 —— 但前提是 `latest.json` 能生成,这需要三个平台都至少有产物。

### C. 验证 updater 端到端

即使签名文件齐了,**从没实测过**"检查更新 → 下载 → 安装 → 重启"。需要:
1. 发一个真实版本
2. 装旧版
3. 点版本号看能否发现新版

---

## 五、本次会话已完成的功能改动(都已推 origin/main)

### agent-session-format 0.9.0(已发 npm)

修了两个实测确认的缺陷:

**1. opencode 丢 token**
`if (!textContent) continue` 把无 text part 的消息整条丢掉,token 一起丢。
实测 40 会话:2227 条消息被丢,其中 2221 条带 token,**445M cacheRead 消失**。
修法:token 附到承载它的消息上。

**2. antigravity projectPath 恒为 null**
20/20 会话全落进 `(unknown)` 项目卡。改从 `tool_calls[].args.Cwd` 读,**17/20 解析成功**。

这个 bug 踩了三个坑(都写进注释了):
- 路径众数启发式 → 15/20 塌成 `/home/<user>`($HOME 是所有路径的根,提词最多)
- 固定深度 → 3 段给容器目录 `/home/u/Projects`,4 段给无关的 `/home/u/.gemini/…`
- 正则抓 `"Cwd"` 匹配 0 —— 字段是**双层转义**的
- 最终坑:`args.Cwd` 的值是 `"/home/u/proj"` **带字面引号**,裸 `startsWith("/")` 把 23 个有效值全拒了(实测 23 present / 0 accepted)

### session-forge

- 升到 asf 0.9.0,`INGEST_FORMAT_VERSION` → 10
- **hermes 接入**:`~/.hermes/state.db` 之前匹配不上任何启发式签名,44 会话 / 14154 消息完全没被收录。加了 `state.db` + sessions/messages 表结构探测
- **UI 渲染 agent lane**:14381 条子 agent 消息原本不可见
- **agent 自动重部署**(见下,未验证)
- 版本号显示 + updater 插件

---

## 六、未验证的关键改动 ⚠️

### agent 自动重部署

**问题**:`ensureAgent()` 只做存在性探测,任何版本的二进制都满足,所以 9月5日部署的 **0.1.24** 一直"健康",永不更新。而那个 agent 里打包的 asf **早于 cache 列被读取的版本**。

**实测证据**:
- WSL 里 `~/.local/bin/session-forge` = **0.1.24**(部署于 9月5日)
- Windows UI 显示 WSL 会话 **4.90B**
- WSL 原生引擎显示同一批会话 **8.73B**
- 差距全部来自旧解析器

**修法**:新增 `probeAgentVersion()` + 数值化 `compareVersions()`,发现目标落后就用打包的新二进制覆盖部署。

**为什么未验证**:修复提交(`048a710`)在我手动替换 agent 之后才推的,而 Windows 上跑的引擎还是旧版,没有版本比对逻辑。而且 rev 去重会跳过已存的行 —— 我已 bump ingest 到 10 强制重扫,但**从没跑过一次完整的跨机重扫验证数字真的变了**。

**我手动做过的事**(可能需要清理):
- 把 `~/.local/bin/session-forge` 换成了 0.3.0,旧的备份在 `/tmp/sf-agent-backup-0.1.24`(重启后会消失)

### hermes 跨机不显示(kimi 接手后修的第二个 bug,`0680285`)

**症状**:Windows 引擎(新版,18 tools)扫 WSL,antigravity 20 会话进去了,hermes 44 会话一条没有;WSL 原生扫描两边都有。

**根因(两层,都在 `src/discovery.ts`)**:
1. `scanGroup` 只把 `opencode-sqlite` 路由到 agent 扫描,`hermes-sqlite` 漏了 → Windows 引擎直接用普通 reader 经 UNC 开 `state.db`,SQLite 在 UNC 上拿不到锁,静默读空
2. 就算路由过去也会被第二处坑掉:`scanGroupViaAgent` 的 `--tools` **硬编码 "opencode"**,hermes 候选传过去 agent 还是只扫 opencode

**修法**:所有 sqlite family 都走 agent 通道;`--tools` 传候选自己的 base tool id。已验证 agent 侧 `scan-jsonl --tools hermes` 在 WSL 输出全部 44 会话。**跨机端到端(Windows 装 0.3.1 后重扫)仍待验证。**

### antigravity "不显示" —— 不是 bug(实测结论)

Windows 库里 20 个会话在 10-05 15:52 那轮扫描就已入库,17 个带 projectPath(asf 0.9.0 修复生效)。首页**项目网格是按 token 取前 12 的卡**,antigravity 总共才 ~0.8M token 排不进去;会话视图按来源筛 `gemini-antigravity` 能看到全部。如果要在网格露脸,得改网格的取数逻辑(设计决策,不是缺陷)。

### Windows 4177 端口冲突

症状:`ENGINE OFFLINE · 引擎未响应`

根因:**WSL2 的 localhost 转发**让 Windows 和 WSL 共享 `127.0.0.1` 的监听。WSL 里 agent-behavior-lab 的 `harness-book`(VitePress)占着 4177,Windows 引擎绑不上,反复 `EADDRINUSE` 崩溃 5 次后放弃。

迷惑之处:Windows 上 `Get-NetTCPConnection -LocalPort 4177` 显示**零监听者**(WSL 占的不算),但请求 4177 能拿到 Vite 的 HTML。

处理:把 harness-book 迁到 4188(现在跑在那儿,是 agent 起的进程)。

**注意**:`src/cli.ts:477` 和 `src-tauri/src/lib.rs:15` 都硬编码 4177,**没做端口自动协商**。这个隐患还在,任何 WSL 服务再占 4177 就会复现。

---

## 七、Token 数据现状

| | WSL 原生 | Windows(跨机扫描) |
|---|---|---|
| sessions | 2349 | 2381 |
| tokensIn | **8.728B** | 4.954B |
| cache | 7.688B | ~4.3B |
| tokensOut | 50.02M | 31.71M |

**两个数不能相加** —— 是同一批 WSL 会话被两台机器各记一遍,口径不同(Windows 侧走的是那个旧 agent)。
真实总量看 **WSL 侧的 8.73B**。

构成(WSL):opencode 4.303B(1479 会话)· kimi-code 3.706B(660)· codex 0.609B · hermes 0.003B

报告文件:`docs/token-report-2026-10-04.md`

---

## 八、磁盘事故(重要教训)

**我曾把 D 盘写满导致 WSL 起不来。** opencode.db 是 67GB,我在 `/tmp` 里连开两份完整拷贝,加上当时 316G 的 vhdx,把 332G 的 D 盘写到只剩 4.3G。

根因:WSL 根文件系统在 `D:\WSL\UbuntuRecover\ext4.vhdx`,**WSL 删除文件不会自动收缩 vhdx**,所以空间只增不减。回收方法:`wsl --shutdown` 后用 PowerShell `Optimize-VHD`(或 diskpart compact)—— 已回收过一次,316G → 269G。

**规矩**:动 >10GB 文件前先 `df -h / /mnt/d`;调查取证优先只读查询或 `immutable=1`,不要整库复制。

---

## 九、常用命令

```bash
# 本地验证(必须全过)
cd ~/Projects/session-forge
bun run test && bun run lint && bun run typecheck

# 只扫不改库(演练)
SESSION_FORGE_TEST_FIXTURES=1 bun run src/cli.ts scan --db /tmp/dry.db

# 真实扫描(会重扫全量,约 30 秒)
bun run src/cli.ts scan --db ~/.session-forge/cache.db

# 发版流程
npm pkg set version=X.Y.Z     # package.json
# 还要同步改:src-tauri/tauri.conf.json、Cargo.toml、Cargo.lock
git commit -m "chore(release): bump version to X.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
# CI 自动 build + publish(OIDC,无需 npm token)

# 查 release 真实结果(别只看 release 页面存在)
gh run list --workflow=release.yml --limit 1
gh run view <id> --json status,conclusion,jobs --jq '.jobs[]|"\(.name): \(.conclusion)"'
gh release view vX.Y.Z --json assets --jq '.assets[].name'
```

---

## 十、环境备忘

- WSL `UbuntuRecover`,根文件系统在 D 盘(vhdx),删除不自动收缩
- Windows 引擎:`E:\Program Files\SessionForge\`,sidecar 在 `resources/`
- 扫描 agent(WSL):`~/.local/bin/session-forge`
- 两个索引库:WSL `~/.session-forge/cache.db` / Windows `C:\Users\Atituiset\.session-forge\cache.db`
- updater 私钥在 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`,本地副本 `~/.tauri/session-forge.key`(**不要提交**)
- pubkey 已硬编码在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`