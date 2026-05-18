import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import path from 'path'
import cors from 'cors'
import { CONFIG } from './config'
import { setupSocket } from './socket'

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

// WebSocket
setupSocket(io)

httpServer.listen(CONFIG.PORT, () => {
  console.log(`🃏 泰和K包服务器已启动 → http://localhost:${CONFIG.PORT}`)
})
