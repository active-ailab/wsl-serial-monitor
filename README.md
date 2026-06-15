# Serial Monitor (WSL & Windows)

[![Version](https://img.shields.io/badge/version-0.3.0-blue)](https://marketplace.visualstudio.com/items?itemName=Roger-Han.wsl-serial-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-Zepp--Hzanj%2Fwsl--serial--monitor-blue?logo=github)](https://github.com/Zepp-Hanzj/wsl-serial-monitor)

在 VS Code 编辑器中打开 COM 串口，实时显示串口日志，支持关键字高亮过滤、日志搜索、数据发送。同时支持 **WSL** 和 **原生 Windows** 环境。提供 **Agent CLI** 用于日志分析和自动化脚本集成。

> 源码：https://github.com/Zepp-Hanzj/wsl-serial-monitor

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🔌 **串口连接** | 优先使用设置中的默认 COM 口和波特率连接，失败后自动扫描并让你选择串口 |
| 📺 **编辑器标签页显示** | 串口日志在独立 WebView 标签页中实时展示，可与代码并排对照 |
| 🔍 **关键字过滤** | 支持多个 Filter，每个可设置独立颜色 |
| 🎨 **Filter 模式切换** | Filter Only（只显示匹配行）/ Highlight All（高亮匹配行，显示全部） |
| 📝 **日志搜索** | `Ctrl+F` 搜索日志内容，支持高亮匹配 + 上下跳转 |
| ⏸ **暂停/恢复** | 暂停滚动查看历史日志 |
| ⬇ **自动滚动** | 新日志自动滚到底部 |
| 📋 **复制日志** | 一键复制全部日志到剪贴板 |
| ✏️ **发送数据** | 支持发送文本或 HEX 数据到串口 |
| ⏱ **时间戳** | 可选为每行添加毫秒级时间戳 |
| 🎨 **暗色主题** | 完美融入 VS Code 暗色主题 |
| 💻 **跨平台** | 支持 WSL（通过 PowerShell 互操作）和原生 Windows |
| 💾 **日志保存** | 在设置中指定保存目录后，每次点击保存会生成一个带时间戳后缀的 `.log` 文件 |
| 🤖 **Agent 日志 CLI** | 扩展自动写入结构化 NDJSON 日志，CLI 可只读查询 `sessions/tail/search/context`，支持正则表达式、上下文查看和实时跟踪，不会抢占串口 |
| ⚡ **虚拟滚动** | 日志超过 1000 行时自动启用虚拟滚动，大幅提升大量日志时的渲染性能 |

## 📸 使用界面

```
┌──────────────────────────────────────────────────────────────┐
│ [🟢 COM7 @ 115200] [⚡ Connect] [⏸ Pause] [🗑 Clear] [📋 Copy] [⏱] [156] │ Search: [________] [▲][▼] │
├──────────────────────────────────────────────────────────────┤
│ 🔍 [✓] ⊘ [✓ keyword1 🟢][✓ keyword2 🔵] [＋ Add Filter] [156/156] [Clear All] │
├──────────────────────────────────────────────────────────────┤
│ L_PSY sys_work hal psy cb temp =31                          │
│ I>23.034 VOLT sys_work PM:INFO 93722 96 44750 53437 31 4960 │
│ MX_DUMP:8080 0ed2 0000 0ed2 0fd0 0ed2 0fcf 4452 00        │
│ W>23.037 WQ sys_work work too long     14.00 ms 0x48197196 │
│ I>23.154 chargeSe SBEngine [thermostatTempListener] temp:31 │
│ W>30.374 PM_LOCKS sys_work PM_AUDIO lock too long           │
└──────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 安装

**方式一：VS Code 扩展商店**

1. 打开 VS Code → 扩展面板 (`Ctrl+Shift+X`)
2. 搜索 `WSL Serial Monitor`
3. 点击安装

**方式二：命令行安装**

```bash
code --install-extension Roger-Han.wsl-serial-monitor
```

**方式三：从 VSIX 安装**

```bash
code --install-extension wsl-serial-monitor-0.3.0.vsix
```

### 使用

1. 按 `Ctrl+Alt+S` 或运行命令 `WSL Serial: Open Serial Port`
2. 如果设置了默认 COM 口，扩展会先自动尝试用默认波特率连接
3. 只有默认串口打开失败时，才会扫描 COM 口并弹出选择列表
4. 串口日志在编辑器右侧标签页中实时显示
5. 点击保存按钮时，日志会写入设置中的目录，文件名格式为 `{prefix}_{yyyyMMdd_HHmmss}.log`
6. 扩展会同时在工作区 `logs/` 目录写入结构化 `.ndjson` session 文件，供 CLI 和 Agent 查询

### Agent 日志 CLI

扩展仍然独占 COM 串口，CLI 只读取扩展落盘的结构化日志，因此可以给 GitHub Copilot、Codex、Claude Code 或 shell 脚本使用，而不会和 VS Code 串口连接冲突。

发布安装后，先在 VS Code 命令面板运行：

```text
Serial: Copy Agent CLI Command
```

这会复制一个指向已安装扩展目录的稳定命令，例如：

```bash
/home/user/.vscode-server/data/User/globalStorage/roger-han.wsl-serial-monitor/bin/wsl-serial-monitor logs sessions
```

把末尾命令替换成需要的子命令即可：

```bash
.../wsl-serial-monitor logs sessions
.../wsl-serial-monitor logs tail --session latest --lines 100
.../wsl-serial-monitor logs search --session latest --query "panic|error|reset" --regex --json
.../wsl-serial-monitor logs context --session latest --query watchdog --before 30 --after 80 --json
```

如果日志目录不在默认位置，显式指定日志目录：

```bash
.../wsl-serial-monitor logs search --log-dir /path/to/logs --session latest --query panic --json
```

不传 `--log-dir` 时，CLI 会优先读取扩展配置的结构化日志目录。

源码开发时可以使用本仓库脚本：

```bash
npm run compile
npm run logs -- sessions
npm run logs -- tail --session latest --lines 100
```

NDJSON 每行是一条事件，核心字段包括 `ts`、`sessionId`、`port`、`baudRate`、`source`、`text` 和 `raw`。当前 `raw` 是已解码文本按 UTF-8 重新编码的 hex，适合检索和诊断，不等同于串口原始字节抓包。

### CLI 使用场景

**查看所有日志会话**：
```bash
.../wsl-serial-monitor logs sessions
```

**查看最新日志的最后 50 行**：
```bash
.../wsl-serial-monitor logs tail --session latest --lines 50
```

**实时跟踪日志（类似 `tail -f`）**：
```bash
.../wsl-serial-monitor logs tail --session latest --follow
```

**搜索错误和异常**：
```bash
.../wsl-serial-monitor logs search --session latest --query "panic|error|reset|fail" --regex --json
```

**查看 watchdog 相关日志的上下文**：
```bash
.../wsl-serial-monitor logs context --session latest --query watchdog --before 30 --after 80 --json
```

**搜索特定时间范围的日志**（结合 shell 工具）：
```bash
.../wsl-serial-monitor logs search --session latest --query "08:40:" --json | jq '.[] | select(.event.text | contains("error"))'
```

**统计特定关键字出现次数**：
```bash
.../wsl-serial-monitor logs search --session latest --query "SBEngine" --json | jq length
```

**查看会话统计信息**：
```bash
.../wsl-serial-monitor logs stats --session latest
```

**导出为 CSV 格式**：
```bash
.../wsl-serial-monitor logs export --session latest --format csv --output logs.csv
```

**导出为 JSON 格式（美化）**：
```bash
.../wsl-serial-monitor logs export --session latest --format json --pretty --output logs.json
```

**实时监控错误和异常**：
```bash
.../wsl-serial-monitor logs watch --session latest --query "error|panic|fail" --regex
```

**监控多个模式（不同颜色）**：
```bash
.../wsl-serial-monitor logs watch --session latest --pattern "error:#f44747" --pattern "warning:#ffa500" --pattern "SBEngine:#4ec9b0"
```

**只显示匹配行（过滤模式）**：
```bash
.../wsl-serial-monitor logs watch --session latest --query "watchdog" --filter-only
```

**检测到匹配时执行命令**：
```bash
.../wsl-serial-monitor logs watch --session latest --query "panic" --exec "notify-send 'Panic detected!'"
```

## 📋 命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| `WSL Serial: Open Serial Port` | `Ctrl+Alt+S` | 选择 COM 口并打开 |
| `WSL Serial: Close Serial Port` | — | 关闭当前串口 |
| `WSL Serial: List Available Ports` | — | 列出所有可用 COM 口 |
| `WSL Serial: Send Data to Serial Port` | — | 发送数据（文本或 HEX） |
| `WSL Serial: Clear Log View` | — | 清空日志 |
| `WSL Serial: Save Log to File` | — | 保存当前缓冲区日志到设置目录 |
| `WSL Serial: Copy Agent CLI Command` | — | 复制已安装扩展生成的 Agent CLI 调用命令 |
| `WSL Serial: Open Settings` | — | 打开扩展设置 |

## 🔍 Filter 使用

1. 点击 **＋ Add Filter** 添加一个过滤器
2. 输入关键字（大小写不敏感）
3. 点击颜色块设置高亮颜色
4. 可添加多个 Filter，每个有独立颜色

**两种模式**：

| 模式 | 说明 |
|------|------|
| **Highlight All**（默认） | 所有日志都显示，匹配行带颜色高亮 |
| **Filter Only**（勾选 ⊘） | 只显示匹配 Filter 的行，其余隐藏 |

勾选/取消 ⊘ 时，已有行和新到达的行都会立即切换模式。

## ⚙️ 配置

在 VS Code 设置中搜索 `wsl-serial-monitor`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `defaultBaudRate` | `115200` | 默认波特率 |
| `defaultPort` | `""` | 默认串口号，例如 `COM7`；如果打开失败则自动扫描并提示选择 |
| `bufferSize` | `2M` | 日志缓冲区大小，支持 `K` / `M` 后缀，范围 `100K` 到 `256M` |
| `defaultDataBits` | `8` | 数据位（5/6/7/8） |
| `defaultStopBits` | `One` | 停止位（One/OnePointFive/Two） |
| `defaultParity` | `None` | 校验位（None/Odd/Even/Mark/Space） |
| `showTimestamp` | `true` | 是否在每行添加时间戳（WebView 中的 ⏱ 复选框更方便） |
| `maxLogLines` | `50000` | 最大日志行数 |
| `encoding` | `utf-8` | 字符编码 |
| `powershellPath` | `powershell.exe` | PowerShell 路径 |
| `lineEnding` | `\r\n` | 发送数据的行尾符 |
| `autoReconnect` | `false` | 断开后自动重连 |
| `saveDirectory` | `""` | 日志默认保存目录；为空时使用当前工作区根目录 |
| `saveFilePrefix` | `serial_log` | 日志文件名前缀，最终格式为 `{prefix}_{yyyyMMdd_HHmmss}.log` |
| `agentLogDirectory` | `logs` | 结构化 Agent 日志目录；相对路径基于当前工作区根目录 |
| `logRotationMaxAgeDays` | `30` | 自动删除超过此天数的 Agent 日志文件 |
| `logRotationMaxFiles` | `100` | 最多保留的 Agent 日志文件数量 |
| `logRotationMaxTotalSizeMB` | `500` | Agent 日志目录最大总大小（MB） |

## 🏗 工作原理

```
┌──────────────────────────────────────────────────────────────┐
│  VS Code (WSL Linux 或 原生 Windows)                         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  WebView Tab (串口日志)                                 │  │
│  │  Filter │ Search │ Pause │ Copy │ Send │ Timestamp     │  │
│  └────────────────────────────────────────────────────────┘  │
│                         ▲ 数据流                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Extension Host                                        │  │
│  │  serialPort.ts → TCP 客户端 ←──────┐                   │  │
│  │  serialMonitorView.ts → WebView    │                   │  │
│  └────────────────────────────────────┼───────────────────┘  │
│                                       │ TCP Socket            │
│  ┌────────────────────────────────────┼───────────────────┐  │
│  │  PowerShell (Windows)              │                   │  │
│  │  TCP 监听器 ←──────────────────────┘                   │  │
│  │  System.IO.Ports.SerialPort → COMx                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                       │                       │
│  ┌────────────────────────────────────▼───────────────────┐  │
│  │  串口设备 (手表/开发板/调试器)                          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 通信协议

扩展使用 **TCP Socket** 桥接串口数据（而非 stdin/stdout），完全避免了管道缓冲问题：

- **PS → Node.js**：原始串口字节流 + 控制消息 (`CONNECTED|...`, `DISCONNECTED|...`, `ERROR|...`)
- **Node.js → PS**：`HEX:<hexdata>\n`（发送数据）, `QUIT\n`（关闭）

### 平台适配

| 环境 | PowerShell 路径 | TCP 连接目标 | 脚本路径 |
|------|----------------|-------------|---------|
| **WSL** | `powershell.exe`（WSL 互操作） | Windows 宿主机 IP（通过 `ip route` 获取） | `wslpath -w` 转换 |
| **原生 Windows** | `powershell.exe`（直接调用） | `127.0.0.1` | 直接使用 `%TEMP%` |

扩展自动检测运行环境，无需手动配置。

## 🔧 环境要求

### WSL 环境

- VS Code ≥ 1.80
- WSL（Windows Subsystem for Linux）
- Windows PowerShell (`powershell.exe`) 可从 WSL 调用
- 串口设备已连接到 Windows 宿主机

**验证 PowerShell 互操作**：

```bash
which powershell.exe
powershell.exe -Command "Write-Output 'Hello from Windows'"
```

### 原生 Windows 环境

- VS Code ≥ 1.80
- Windows PowerShell 5.1+ 或 PowerShell Core 7+
- 串口设备已连接到本机

### Windows 防火墙

首次使用时 Windows 可能弹出防火墙提示，需允许 PowerShell 监听本地 TCP 端口。如果不小心拒绝了，可以手动添加规则：

```powershell
# 在 Windows PowerShell (管理员) 中运行
New-NetFirewallRule -DisplayName "WSL Serial Monitor" -Direction Inbound -LocalPort 40000-59999 -Protocol TCP -Action Allow
```

## 🐛 故障排查

### 找不到 COM 口

- 确认设备已连接（WSL: 连接到 Windows 宿主机；Windows: 连接到本机）
- 在终端运行 `powershell.exe -Command "Get-CimInstance Win32_PnPEntity | Where-Object {$_.Name -match 'COM'}"` 验证

### 连接后没有日志输出

- 检查 Output 面板（`Ctrl+Shift+U` → 选 `WSL Serial Monitor`）是否有 `[DATA #N]` 日志
- 如果有但 WebView 不显示，请 Reload Window 后重试
- 确认波特率与设备端一致

### 权限错误

- 确认没有其他串口工具占用了该 COM 口
- WSL: 检查 `/etc/wsl.conf` 中是否启用了互操作

### PowerShell 无法调用

- WSL: 检查 `/etc/wsl.conf` 中 `interopEnabled=true`
- 可尝试使用完整路径：设置 `wsl-serial-monitor.powershellPath` 为 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`

### Agent CLI 找不到日志

- 先确认扩展已经连接过串口，并且 Output 面板中出现过 `[LOG] Session ... -> ...`
- 发布安装版先运行命令 `Serial: Copy Agent CLI Command`，用复制出来的命令查询 session
- 源码开发版可以在仓库根目录运行 `npm run logs -- sessions`
- 如果是在 Extension Development Host 中调试，确认 `.vscode/launch.json` 的 `args` 包含 `--folder-uri=${workspaceFolder}`，否则调试窗口可能没有 workspace，结构化日志会写到 VS Code global storage；CLI 不传 `--log-dir` 时会自动尝试读取该目录
- 如果日志目录不在默认位置，显式指定路径：`.../wsl-serial-monitor logs sessions --log-dir /absolute/path/to/logs`
- Agent 应调用 Agent CLI 读取日志，不应直接打开 COM 口

## 🛠 从源码构建

```bash
# 克隆仓库
git clone https://github.com/Zepp-Hanzj/wsl-serial-monitor.git
cd wsl-serial-monitor

# 安装依赖
npm install

# 编译
npm run compile

# 测试
npm test

# 查询结构化 Agent 日志
npm run logs -- sessions

# 打包
npm install -g @vscode/vsce
vsce package

# 安装
code --install-extension wsl-serial-monitor-0.3.0.vsix
```

### 开发调试

在 VS Code 中打开项目文件夹，按 `F5` 启动扩展开发主机进行调试。

## 📝 更新日志

### v0.3.0

- **Agent Log CLI**：新增命令行工具，支持 `sessions`、`tail`、`search`、`context`、`stats`、`export`、`watch` 子命令，可只读查询结构化 NDJSON 日志，不抢占串口
- **结构化日志存储**：扩展自动写入 NDJSON 格式的 session 日志文件，包含时间戳、会话 ID、端口、波特率等元数据
- **虚拟滚动**：日志超过 1000 行时自动启用虚拟滚动，大幅提升大量日志时的渲染性能
- **日志轮转**：支持按天数、文件数量、总大小自动清理过期日志
- **AI Agent 集成**：新增 Agent CLI 计划文档，支持 GitHub Copilot、Codex、Claude Code 等 AI 工具读取日志进行分析
- **单元测试**：新增 `logStore` 和 `agent-log-cli` 测试用例

##  许可证

[MIT License](LICENSE)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'Add amazing feature'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 创建 Pull Request
