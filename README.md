# claw2boox

将 BOOX 墨水屏平板变成 OpenClaw 信息面板。一条命令启动。

## 快速开始

### 1. 在运行 OpenClaw 的电脑上

确保 OpenClaw 已安装并运行（`openclaw` 或 `openclaw onboard --install-daemon`），然后：

```bash
npx claw2boox
```

终端会显示：

```
╔════════════════════════════════════════════════════╗
║                     claw2boox                      ║
║            OpenClaw Dashboard for BOOX             ║
╠════════════════════════════════════════════════════╣
║                                                    ║
║                 配对码 (Pairing Code):               ║
║                                                    ║
║                     4 8 2 9 1 3                    ║
║                                                    ║
║        在 BOOX App 中输入以上数字即可完成配对          ║
║                   5 分钟内有效                       ║
║                                                    ║
╠════════════════════════════════════════════════════╣
║  Server: http://192.168.1.100:3000                 ║
║  mDNS:   my-mac (auto-discoverable)               ║
╚════════════════════════════════════════════════════╝
```

就这样。不需要编辑任何配置文件。

### 2. 在 BOOX 设备上

1. 安装 APK（从 [GitHub Releases](https://github.com/Kennethwwww/claw2boox/releases) 下载）
2. 打开 App → 自动发现局域网内的服务器（mDNS）
3. 输入终端上显示的 6 位配对码
4. 完成 ✓

### 如果 OpenClaw 在远程机器上

```bash
npx claw2boox --gateway 192.168.1.5        # 指定 Gateway IP
npx claw2boox --gateway 192.168.1.5 --password mypass  # 带密码
```

## 功能

- **零配置启动**：自动检测本地 OpenClaw Gateway，自动生成配对码
- **设备配对**：仅限 BOOX（ONYX）设备，通过 6 位配对码安全配对
- **mDNS 自动发现**：BOOX App 自动发现局域网内的服务器，无需手输 IP
- **系统状态**：实时显示 Gateway 连接状态、活跃会话、在线节点
- **信息简报**：接收 OpenClaw cron 定时推送的简报内容
- **墨水屏优化**：纯黑白界面，无动画，大字体，5 分钟自动刷新

## 架构

```
OpenClaw Gateway (ws://host:18789)
        ↕ WebSocket
  claw2boox (Node.js, port 3000)
        ↕ HTTP + WS (Token 认证) + mDNS
  BOOX Android App (WebView + NSD)
```

## 命令参考

```bash
npx claw2boox                          # 启动（自动检测 Gateway）
npx claw2boox --gateway <ip>           # 指定 Gateway 地址
npx claw2boox --port 3001              # 自定义端口（默认 3000）
npx claw2boox --password <pass>        # Gateway 密码
npx claw2boox status                   # 查看配对状态
npx claw2boox unpair                   # 解除所有已配对设备
npx claw2boox --help                   # 查看帮助
```

## 配置定时简报（可选）

在 OpenClaw 中创建 cron 任务，定时推送简报到 BOOX：

```bash
# 每天早上 7 点推送晨间简报
openclaw cron add --name "morning-briefing" --cron "0 7 * * *" \
  --session "cron:claw2boox-briefing" \
  --system-event "编写晨间简报：天气、待办、重要消息。纯文本 200 字以内。"

# 每小时推送状态
openclaw cron add --name "hourly-status" --cron "0 * * * *" \
  --session "cron:claw2boox-briefing" \
  --system-event "汇总过去 1 小时系统状态，纯文本 100 字以内。"
```

## 网络配置

| 场景 | 方法 |
|------|------|
| 同一局域网 | 直接使用，mDNS 自动发现 |
| 远程访问 | 推荐 [Tailscale](https://tailscale.com)，两端安装后用 Tailscale IP |

## 设备管理

```bash
npx claw2boox status                    # 查看已配对设备
npx claw2boox unpair                    # 解除所有配对
curl -X DELETE localhost:3000/api/devices/{id}  # 解除指定设备
```

## 项目结构

```
claw2boox/
├── bin/claw2boox.js        # CLI 入口（npx 执行点）
├── server/                 # Node.js 服务端
│   ├── server.js           # Express + WS 代理 + 配对 API + mDNS
│   └── lib/
│       ├── pairing.js      # 配对管理 (SQLite, ~/.claw2boox/)
│       └── ws-proxy.js     # OpenClaw Gateway WS 代理
├── dashboard/              # Web 仪表板（墨水屏优化）
│   ├── index.html
│   ├── style.css
│   ├── pair/               # 配对页面（带服务器自动发现）
│   └── js/                 # 面板逻辑
├── android/                # BOOX Android App (Kotlin WebView + NSD)
│   └── app/src/main/java/com/claw2boox/
│       ├── MainActivity.kt
│       └── ServerDiscovery.kt
└── package.json            # npm 包配置（支持 npx）
```

## 开发

```bash
git clone https://github.com/Kennethwwww/claw2boox.git
cd claw2boox
npm install
npm run dev                 # 带 --watch 自动重启
```

Android App 构建：
```bash
cd android && ./gradlew assembleRelease
```

## 设计决策

| 决策 | 原因 |
|------|------|
| `npx` 零配置启动 | 降低用户门槛，一条命令搞定 |
| mDNS 自动发现 | BOOX 用户不需要手输 IP 地址 |
| WebView App | 核心逻辑在 Web 端，便于迭代，App 仅负责设备验证 |
| 仅限 BOOX 设备 | `Build.MANUFACTURER == "ONYX"` 验证，确保配对唯一性 |
| `~/.claw2boox/` 存储 | 数据不随项目目录，npx 多次运行保持配对状态 |
| HTTP 轮询 + WS 推送 | E-ink 设备休眠会断 WS，唤醒后 HTTP 立即获取最新数据 |

## License

MIT
