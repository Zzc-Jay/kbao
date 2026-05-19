#!/bin/bash
set -e

cd "$(dirname "$0")/packages/server"

echo "==> 安装依赖..."
npm install --production

echo "==> 构建 TypeScript..."
npx tsc

echo "==> 停止旧进程..."
pkill -f "node dist/index.js" 2>/dev/null || echo "  没有旧进程在运行"

echo "==> 启动服务..."
nohup node dist/index.js > server.log 2>&1 & disown

sleep 2

if pgrep -f "node dist/index.js" > /dev/null; then
  echo "==> 服务启动成功!"
  cat server.log
else
  echo "==> 启动失败，查看日志："
  cat server.log
  exit 1
fi
