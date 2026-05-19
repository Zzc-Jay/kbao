#!/bin/bash
set -e

echo "==> 安装 server 依赖..."
cd "$(dirname "$0")/packages/server"
npm install

echo "==> 构建 kbao-core..."
cd ../kbao-core
npm install
npx tsc

echo "==> 构建 server..."
cd ../server
npx tsc

if pm2 describe kbao-server > /dev/null 2>&1; then
  echo "==> 重启服务..."
  pm2 restart kbao-server
else
  echo "==> 首次启动服务..."
  pm2 start dist/index.js --name kbao-server
fi

echo "==> 服务状态："
pm2 status kbao-server

echo ""
echo "==> 最近日志："
pm2 logs kbao-server --lines 10 --nostream
