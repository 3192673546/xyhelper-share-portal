#!/bin/bash

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "未找到 Docker，无法执行部署自检。"
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "未找到 curl，请先安装：apt-get install -y curl"
  exit 1
fi

on_error() {
  echo ""
  echo "自检失败。下面是容器状态和关键日志："
  docker compose ps || true
  docker compose logs --tail=80 portal chatgpt-share-server || true
}
trap on_error ERR

docker compose config --quiet

for service in mysql redis portal chatgpt-share-server auditlimit; do
  container_id="$(docker compose ps -q "$service")"
  if [ -z "$container_id" ]; then
    echo "服务未创建：$service"
    exit 1
  fi
  status="$(docker inspect -f '{{.State.Status}}' "$container_id")"
  if [ "$status" != "running" ]; then
    echo "服务未运行：$service（$status）"
    exit 1
  fi
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
  if [ "$health" = "unhealthy" ]; then
    echo "服务健康检查失败：$service"
    exit 1
  fi
  echo "容器正常：$service（health=$health）"
done

portal_port="$(sed -n 's/^PORTAL_PORT=//p' .env 2>/dev/null | tail -n 1)"
share_port="$(sed -n 's/^SHARE_PORT=//p' .env 2>/dev/null | tail -n 1)"
portal_url="${PORTAL_CHECK_URL:-http://127.0.0.1:${portal_port:-8800}}"
share_url="${SHARE_CHECK_URL:-http://127.0.0.1:${share_port:-8300}}"

check_url() {
  local label="$1"
  local url="$2"
  local attempts=20
  local status
  for ((index = 1; index <= attempts; index += 1)); do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$url" || true)"
    if [[ "$status" =~ ^[23][0-9][0-9]$ ]]; then
      echo "HTTP 正常：$label（$url，状态码 $status）"
      return 0
    fi
    sleep 2
  done
  echo "HTTP 检查失败：$label（$url，最后状态码 ${status:-无}）"
  return 1
}

check_url "用户门户" "${portal_url%/}/healthz"
check_url "ChatGPT Share" "${share_url%/}/"

config_json="$(curl -fsS --max-time 8 "${portal_url%/}/api/config")"
if [[ "$config_json" != *'"siteName"'* || "$config_json" != *'"paymentEnabled"'* ]]; then
  echo "门户配置接口返回格式异常。"
  exit 1
fi

echo ""
echo "部署自检通过。现在可在浏览器打开："
echo "用户门户：$portal_url"
echo "ChatGPT Share：$share_url"
