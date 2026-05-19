import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import path from 'path'
import cors from 'cors'
import { CONFIG } from './config'
import { setupSocket } from './socket'
import { setupWebSocket } from './ws-handler'

const app = express()
app.use(cors({ origin: CONFIG.CORS_ORIGIN }))
app.use(express.static(path.join(__dirname, '..', 'public')))

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: CONFIG.CORS_ORIGIN },
  pingInterval: CONFIG.HEARTBEAT_INTERVAL,
  pingTimeout: CONFIG.HEARTBEAT_TIMEOUT,
})

// 健康检查
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: Date.now() })
})

// Socket.IO（浏览器客户端）
setupSocket(io)

// 原生 WebSocket（微信小程序客户端，端点 /ws）
setupWebSocket(httpServer)

httpServer.listen(CONFIG.PORT, () => {
  console.log(`🃏 泰和K包服务器已启动 → http://localhost:${CONFIG.PORT}`)
  console.log(`  WebSocket 端点: ws://localhost:${CONFIG.PORT}/ws`)
})
