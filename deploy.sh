#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v openssl >/dev/null 2>&1; then
  echo "部署需要 openssl 来生成安全密钥，请先安装：apt-get install -y openssl"
  exit 1
fi

FIRST_ENV=0
if [ ! -f .env ]; then
  cp .env.example .env
  FIRST_ENV=1
fi

ADMIN_PASSWORD_GENERATED=""
XYHELPER_ADMIN_PASSWORD_GENERATED=""

ensure_secret() {
  key="$1"
  placeholder="$2"
  bytes="$3"
  value="$(sed -n "s/^${key}=//p" .env | tail -n 1)"

  if [ -z "${value}" ] || [ "${value}" = "${placeholder}" ]; then
    value="$(openssl rand -hex "${bytes}")"
    if grep -q "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      printf '\n%s=%s\n' "${key}" "${value}" >> .env
    fi
    if [ "${key}" = "ADMIN_PASSWORD" ]; then
      ADMIN_PASSWORD_GENERATED="${value}"
    fi
    if [ "${key}" = "XYHELPER_ADMIN_PASSWORD" ]; then
      XYHELPER_ADMIN_PASSWORD_GENERATED="${value}"
    fi
  fi
}

ensure_secret ADMIN_PASSWORD CHANGE_ME_ADMIN_PASSWORD 16
ensure_secret OAUTH_SHARED_SECRET CHANGE_ME_OAUTH_SECRET 32
ensure_secret MYSQL_ROOT_PASSWORD CHANGE_ME_MYSQL_ROOT_PASSWORD 24
ensure_secret MYSQL_APP_PASSWORD CHANGE_ME_MYSQL_APP_PASSWORD 24
ensure_secret JWT_SECRET CHANGE_ME_JWT_SECRET 32
ensure_secret XYHELPER_ADMIN_PASSWORD CHANGE_ME_XYHELPER_ADMIN_PASSWORD 16
chmod 600 .env

env_value() {
  sed -n "s/^${1}=//p" .env | tail -n 1
}

MYSQL_APP_PASSWORD_VALUE="$(env_value MYSQL_APP_PASSWORD)"
JWT_SECRET_VALUE="$(env_value JWT_SECRET)"
XYHELPER_ADMIN_PASSWORD_VALUE="$(env_value XYHELPER_ADMIN_PASSWORD)"

if ! [[ "${MYSQL_APP_PASSWORD_VALUE}" =~ ^[A-Za-z0-9_-]{16,128}$ ]]; then
  echo "MYSQL_APP_PASSWORD 只能使用 16–128 位字母、数字、下划线或连字符。"
  exit 1
fi
if ! [[ "${JWT_SECRET_VALUE}" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  echo "JWT_SECRET 只能使用 32–128 位字母、数字、下划线或连字符。"
  exit 1
fi
if ! [[ "${XYHELPER_ADMIN_PASSWORD_VALUE}" =~ ^[A-Za-z0-9_-]{12,128}$ ]]; then
  echo "XYHELPER_ADMIN_PASSWORD 只能使用 12–128 位字母、数字、下划线或连字符。"
  exit 1
fi

# 只把真实数据库/JWT 密钥写入被 Git 忽略的运行时目录。
mkdir -p data/generated data/generated-db-init data/portal
sed \
  -e "s|__MYSQL_APP_PASSWORD__|${MYSQL_APP_PASSWORD_VALUE}|g" \
  -e "s|__JWT_SECRET__|${JWT_SECRET_VALUE}|g" \
  config.template.yaml > data/generated/config.yaml
XYHELPER_ADMIN_PASSWORD_MD5="$(printf '%s' "${XYHELPER_ADMIN_PASSWORD_VALUE}" | openssl dgst -md5 -r | awk '{print $1}')"
sed \
  -e "s|__XYHELPER_ADMIN_PASSWORD_MD5__|${XYHELPER_ADMIN_PASSWORD_MD5}|g" \
  docker-entrypoint-initdb.d/schema.sql > data/generated-db-init/schema.sql
# 容器内进程可能不是 root，需要只读权限；目录仍只保存于本机且不会提交到 Git。
chmod 755 data/generated data/generated-db-init
chmod 644 data/generated/config.yaml data/generated-db-init/schema.sql

if [ "${FIRST_ENV}" -eq 1 ]; then
  echo "已生成 .env、数据库密钥和 JWT 密钥。请妥善保存 .env。"
fi
if [ -n "${ADMIN_PASSWORD_GENERATED}" ]; then
  echo "首次登录邮箱：$(env_value ADMIN_EMAIL)"
  echo "首次登录密码：${ADMIN_PASSWORD_GENERATED}"
fi
if [ -n "${XYHELPER_ADMIN_PASSWORD_GENERATED}" ]; then
  echo "XYHelper 后台账号：admin"
  echo "XYHelper 后台密码：${XYHELPER_ADMIN_PASSWORD_GENERATED}"
fi

# portal 镜像使用 uid/gid 1000 运行，提前准备可写且不对其他用户开放的数据目录。
if [ "$(id -u)" -eq 0 ]; then
  chown 1000:1000 data/portal
fi
chmod 700 data/portal

docker compose config --quiet
docker compose pull --ignore-buildable || docker compose pull
docker compose up -d --build --remove-orphans

echo ""
echo "用户门户：默认 http://服务器IP:8800（以 .env 的 PORTAL_PUBLIC_URL 为准）"
echo "ChatGPT Share：默认 http://服务器IP:8300（以 .env 的 SHARE_PUBLIC_URL 为准）"
echo "XYHelper 管理后台：SHARE_PUBLIC_URL/xyhelper"
echo "查看状态：docker compose ps"
echo "查看日志：docker compose logs -f portal chatgpt-share-server"
