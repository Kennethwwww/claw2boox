# claw2boox

将 BOOX 墨水屏平板变成 OpenClaw 信息面板。

## 功能

- **设备配对**：仅限 BOOX（ONYX）设备，通过 6 位配对码安全配对
- **系统状态**：实时显示 OpenClaw Gateway 连接状态、活跃会话、在线节点
- **信息简报**：接收 OpenClaw cron 定时推送的简报内容
- **墨水屏优化**：纯黑白界面，无动画，大字体，5 分钟自动刷新

## 架构

```
OpenClaw Gateway (ws://host:18789)
        ↕ WebSocket
  claw2boox Server (Node.js, port 3000)
        ↕ HTTP + WS (Token 认证)
  BOOX Android App (WebView)
```

## 快速开始

### 1. 部署服务端

```bash
cd server
cp .env.example .env
# 编辑 .env，配置 OpenClaw Gateway 地址
npm install
npm start
```

服务器启动后会显示：
```
[server] claw2boox server running on http://0.0.0.0:3000
```

### 2. 安装 BOOX App

从 [GitHub Releases](https://github.com/yourname/claw2boox/releases) 下载最新 APK，安装到 BOOX 设备。

### 3. 配对

1. **生成配对码**（在服务端机器上）：

```bash
curl -X POST http://localhost:3000/api/pair/generate
```

返回示例：`{"code":"482913","expires_in_seconds":300}`

2. **在 BOOX App 中输入**服务器地址和 6 位配对码

3. 配对成功后自动跳转到仪表板

## 配置 OpenClaw 定时简报

在 OpenClaw 中创建 cron 任务，定时向 `claw2boox-briefing` 会话推送简报：

```
# 示例：每天早上 7 点推送晨间简报
cron.create morning-briefing "0 7 * * *" "编译一份简报，包含：天气概况、今日待办、重要消息摘要。格式为纯文本，200 字以内。"

# 示例：每小时推送状态摘要
cron.create hourly-status "0 * * * *" "汇总过去一小时的系统状态：活跃会话数、错误日志、重要事件。纯文本，100 字以内。"
```

## 网络配置

### 局域网

BOOX 和服务端在同一网络，直接使用局域网 IP：`http://192.168.x.x:3000`

### Tailscale（推荐远程访问）

1. 服务端和 BOOX 均安装 Tailscale
2. 使用 Tailscale IP 或 MagicDNS 访问
3. 可选：`tailscale serve --bg 3000` 暴露为 HTTPS

## 设备管理

```bash
# 查看已配对设备
curl http://localhost:3000/api/devices

# 解除配对
curl -X DELETE http://localhost:3000/api/devices/{device_id}

# 重新生成配对码
curl -X POST http://localhost:3000/api/pair/generate
```

## 项目结构

```
claw2boox/
├── server/                 # Node.js 服务端
│   ├── server.js           # Express + WS 代理 + 配对 API
│   ├── lib/
│   │   ├── pairing.js      # 配对管理 (SQLite)
│   │   └── ws-proxy.js     # OpenClaw Gateway WS 代理
│   └── .env.example
├── dashboard/              # Web 仪表板（服务端托管）
│   ├── index.html          # 主界面
│   ├── style.css           # 墨水屏优化样式
│   ├── pair/               # 配对页面
│   └── js/                 # 面板逻辑
├── android/                # Android WebView App
│   └── app/src/main/
│       └── java/.../MainActivity.kt
└── README.md
```

## 开发

### 服务端开发

```bash
cd server
npm run dev  # 带 --watch 自动重启
```

### Android App 构建

```bash
cd android
./gradlew assembleRelease
# APK 输出: app/build/outputs/apk/release/
```

## 设计决策

| 决策 | 原因 |
|------|------|
| WebView App 而非原生 UI | 核心逻辑在 Web 端，便于快速迭代，App 仅负责设备验证和 Token 管理 |
| 仅限 BOOX 设备 | 通过 `Build.MANUFACTURER == "ONYX"` 验证，确保配对唯一性 |
| SQLite 存储配对信息 | 轻量可靠，支持未来扩展到多设备配对 |
| HTTP 轮询 + WS 推送 | E-ink 设备会休眠断开 WS，唤醒后 HTTP 轮询立即获取最新数据 |
| 5 分钟默认刷新 | E-ink 全屏刷新有闪烁，平衡数据时效性和显示舒适度 |

## License

MIT
