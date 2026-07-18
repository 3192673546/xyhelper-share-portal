# XYHelper ChatGPT Share + 独立用户门户

这是在 `xyhelper/chatgpt-share-server-deploy` 基础上制作的可部署版本。它保留 XYHelper 当前 Docker 镜像作为 ChatGPT 官网 UI、账号池和会话隔离核心，新增一个完全独立的用户门户。

## 已实现功能

- 邮箱注册和登录
- 基础版 / Plus 套餐权限
- 套餐到期和管理员续期
- 自定义指定用户可用车队
- 实时读取 XYHelper 车辆列表
- 短期登录票据，不在跳转地址中暴露永久用户 Token
- XYHelper `OAUTH_URL` 授权适配
- 兑换码批量生成、使用次数和失效时间
- 套餐和价格管理
- 易支付兼容下单、签名验证、异步回调和幂等开通
- 用户、套餐、兑换码、订单管理页面
- SQLite WAL 持久化、CSRF 防护、scrypt 密码哈希和登录限速

> 当前 XYHelper `chatgpt-share-server` 和接入网关仍是 XYHelper 的商业服务。本项目不会绕过其授权或接入点费用。

## 架构

```text
用户浏览器
  ├─ :8800  独立用户门户（注册 / 套餐 / 支付 / 选车）
  └─ :8300  XYHelper ChatGPT Share（官网 UI / 会话）
                   │
                   ├─ OAUTH_URL → portal:8080（检查用户和套餐）
                   └─ CHATPROXY → XYHelper 上游接入点
```

门户数据存放在 `data/portal/portal.db`，XYHelper、MySQL 和 Redis 的数据仍分别存放在原来的 `data/` 目录。

## 服务器要求

- Ubuntu 22.04 或更新版本，x86-64
- Docker Engine 和 Docker Compose v2
- Git、OpenSSL
- 建议至少 2 核 4 GB 内存；账号较多时建议 4 核 8 GB
- 已获得授权的 XYHelper `CHATPROXY` 和 `AUTHKEY`

## 首次部署

```bash
git clone https://github.com/3192673546/xyhelper-share-portal.git
cd xyhelper-share-portal
chmod +x deploy.sh
./deploy.sh
```

首次运行会自动：

1. 从 `.env.example` 创建 `.env`；
2. 生成随机门户密码、XYHelper 后台密码、OAuth 密钥、MySQL 密码和 JWT 密钥；
3. 从无敏感信息的 `config.template.yaml` 生成仅保存在 `data/` 下的运行配置；
4. 在终端显示首次门户管理员密码；
5. 构建门户并启动全部容器。

默认地址：

- 用户门户：`http://服务器IP:8800`
- ChatGPT Share：`http://服务器IP:8300`
- XYHelper 后台：`http://服务器IP:8300/xyhelper`

`.env` 默认使用 `SHARE_PUBLIC_URL=auto`，因此用服务器 IP 打开门户时，“进入车队”会自动跳转到同一 IP 的 8300 端口。绑定独立聊天域名后再改成完整 HTTPS 地址。

门户管理员邮箱默认为 `admin@example.com`。门户密码和 XYHelper 后台密码均由 `deploy.sh` 首次运行时随机生成并显示，请当场保存；脚本不会把这些密码写进公开源码。

部署后执行一次实机自检：

```bash
./smoke-test.sh
```

如果修改了映射端口，脚本会自动读取 `.env`；使用 HTTPS 域名检查时也可以显式传入：

```bash
PORTAL_CHECK_URL=https://portal.example.com SHARE_CHECK_URL=https://chat.example.com ./smoke-test.sh
```

购买 XYHelper 接入点后，在 `.env` 替换：

```dotenv
CHATPROXY=https://你的接入点地址
AUTHKEY=你的接入点密钥
```

## 上线前配置域名

建议分别使用两个子域名：

- `portal.example.com` → 用户门户
- `chat.example.com` → ChatGPT Share

Caddy 示例：

```caddyfile
portal.example.com {
    reverse_proxy 127.0.0.1:8800
}

chat.example.com {
    reverse_proxy 127.0.0.1:8300
}
```

然后修改 `.env`：

```dotenv
PORTAL_BIND=127.0.0.1
SHARE_BIND=127.0.0.1
PORTAL_PUBLIC_URL=https://portal.example.com
SHARE_PUBLIC_URL=https://chat.example.com
COOKIE_SECURE=true
TRUST_PROXY=true
```

应用配置：

```bash
./deploy.sh
```

不要把 `OAUTH_SHARED_SECRET`、数据库密码或 `JWT_SECRET` 放进浏览器代码或提交到 Git。`deploy.sh` 会将真实值写入 `.env` 和 `data/generated/config.yaml`，这两个位置均已被 Git 忽略。

## 添加 ChatGPT 车辆

1. 打开 `SHARE_PUBLIC_URL/xyhelper`；
2. 修改默认管理员密码；
3. 在“账号管理”中添加获得授权的 ChatGPT 官方账号；
4. 确认车辆状态正常；
5. 回到门户的“选择车队”页面刷新。

门户读取 XYHelper 的 `POST /carpage` 接口，管理员不需要重复维护车辆列表。

## 用户开通方式

### 管理员手动开通

进入门户的“站点管理 → 用户”，点击“开通”，选择基础版或 Plus 并填写天数。

### 兑换码

进入“站点管理 → 兑换码”，选择套餐、生成数量、每码可使用次数和可选失效时间。用户在“兑换中心”输入兑换码后自动开通。

### 易支付

在 `.env` 设置：

```dotenv
EPAY_URL=https://pay.example.com/submit.php
EPAY_PID=1000
EPAY_KEY=your-merchant-key
EPAY_TYPE=alipay
EPAY_SIGN_MODE=append
```

如果使用 XYHelper UCenter，`EPAY_URL` 通常形如：

```dotenv
EPAY_URL=https://ucenter.example.com/easy/pay
```

某些易支付服务使用 `参数&key=密钥` 方式签名，此时设置：

```dotenv
EPAY_SIGN_MODE=key_param
```

未填写 `EPAY_URL / EPAY_PID / EPAY_KEY` 时，在线购买自动关闭，不影响兑换码和管理员开通。

## 常用命令

```bash
# 查看状态
docker compose ps

# 查看关键日志
docker compose logs -f portal chatgpt-share-server

# 部署后自检
./smoke-test.sh

# 更新并重建
./deploy.sh

# 可选：启用上游镜像自动更新（默认关闭，升级前建议先备份）
docker compose --profile auto-update up -d watchtower

# 停止
docker compose down
```

## 备份与恢复

停止写入后备份整个 `data` 目录和 `.env`：

```bash
docker compose stop portal chatgpt-share-server
tar -czf xyhelper-share-backup.tar.gz data .env
docker compose start portal chatgpt-share-server
```

恢复时将备份文件解压回项目目录，再运行 `./deploy.sh`。

## 当前边界

- 第一版没有邮件验证和“忘记密码”邮件；管理员可以在后台重置用户密码。
- 支付已实现通用易支付协议，但正式上线前必须用自己的商户沙箱或小额订单验证签名模式。
- 邀请返佣、发卡平台主动同步和多站点商户系统尚未加入。
- 当前门户固定使用 Node.js 24 自带 SQLite；适合小型和中型站点，超大规模可迁移到 PostgreSQL。
- Watchtower 默认不启动，避免 XYHelper 上游镜像更新后接口变化导致站点在无人值守时中断。

## 本地验证

门户不依赖第三方 npm 包：

```bash
cd portal
npm run check
npm test
```

测试覆盖密码哈希、兑换码、订单幂等、支付签名、CSRF、车队权限、短期票据和 XYHelper OAuth 返回格式。

请仅使用获得授权的账号，并遵守账号提供方、支付渠道和所在地的服务条款及法规。
