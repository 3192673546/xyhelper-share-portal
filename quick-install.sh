#!/bin/bash
set -euo pipefail

# 从下载并解压后的项目目录运行时，直接部署当前版本。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "${SCRIPT_DIR}/portal/package.json" ]; then
  exec bash "${SCRIPT_DIR}/deploy.sh"
fi

# 默认从本项目仓库安装；也可以用 REPO_URL / REPO_BRANCH 指向自己的分支。
REPO_URL="${REPO_URL:-https://github.com/3192673546/xyhelper-share-portal.git}"

INSTALL_DIR="${INSTALL_DIR:-chatgpt-share-portal}"
REPO_BRANCH="${REPO_BRANCH:-main}"

git clone --depth=1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"
cd "${INSTALL_DIR}"
exec bash ./deploy.sh
