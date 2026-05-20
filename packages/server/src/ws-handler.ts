/**
 * 原生 WebSocket 处理器 — 为微信小程序 Taro.connectSocket 提供兼容连接
 *
 * 使用简单 JSON 协议替代 Socket.IO：
 *  → 客户端发送: { "event": "事件名", "data": { ... } }
 *  ← 服务端发送: { "event": "事件名", "data": { ... } }
 */

import { WebSocketServer, WebSocket } from 'ws'
import { Server as HttpServer } from 'http'
import { addPlayer, getPlayer, removePlayer, heartbeat, PlayerConn } from './player'
import { createRoom, getRoom, joinRoom, leaveRoom } from './room'
import { Game, GameEventBus } from './game'
import { Card, Combo, Bid, Suit } from 'kbao-core'
import { decideRequestBid, decidePlay, pickGiveCard } from './bot-ai'

const BOT_NAMES = ['阿泰', '阿和', '老K', '包哥', '小牌']

// wsHandle → player 映射
const wsPlayerMap = new Map<WebSocket, string>()

export function setupWebSocket(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

  // 心跳定时器
  const heartbeatTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).__alive === false) {
        ws.terminate()
        return
      }
      (ws as any).__alive = false
      ws.ping()
    })
  }, 30_000)

  wss.on('connection', (ws: WebSocket) => {
    const wsId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    ;(ws as any).__alive = true
    ;(ws as any).__id = wsId
    console.log(`[WS连接] ${wsId}`)

    ws.on('pong', () => { (ws as any).__alive = true })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleMessage(ws, wss, msg)
      } catch (e) {
        send(ws, 'error', { message: '无效的消息格式' })
      }
    })

    ws.on('close', () => {
      console.log(`[WS断开] ${wsId}`)
      handleDisconnect(ws, wss)
    })

    ws.on('error', () => { /* ignore */ })
  })
}

function send(ws: WebSocket, event: string, data: any = {}): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, data }))
  }
}

function broadcastToRoom(wss: WebSocketServer, roomCode: string, event: string, data: any = {}, excludeId?: string): void {
  const room = getRoom(roomCode)
  if (!room) return
  wss.clients.forEach((ws) => {
    const pid = wsPlayerMap.get(ws)
    if (pid && room.players.some(p => p.socketId === pid) && pid !== excludeId) {
      send(ws, event, data)
    }
  })
}

function sendToSeat(wss: WebSocketServer, roomCode: string, seat: number, event: string, data: any): void {
  const room = getRoom(roomCode)
  if (!room) return
  const p = room.players[seat]
  if (!p || p.isBot) return
  wss.clients.forEach((ws) => {
    if (wsPlayerMap.get(ws) === p.socketId) {
      send(ws, event, data)
    }
  })
}

// ─── 消息路由 ───

function handleMessage(ws: WebSocket, wss: WebSocketServer, msg: { event: string; data: any }): void {
  const { event, data } = msg
  switch (event) {
    case 'join': return handleJoin(ws, wss, data)
    case 'room:create': return handleCreateRoom(ws, wss, data)
    case 'room:join': return handleJoinRoom(ws, wss, data)
    case 'room:leave': return handleLeaveRoom(ws, wss)
    case 'room:start': return handleStartGame(ws, wss)
    case 'bid:submit': return handleBidSubmit(ws, wss, data)
    case 'play:submit': return handlePlaySubmit(ws, wss, data)
    case 'play:pass': return handlePlayPass(ws, wss)
    case 'game:ready': return handleReady(ws, wss)
    case 'game:next': return handleNextRound(ws, wss)
    default:
      send(ws, 'error', { message: `未知事件: ${event}` })
  }
}

function handleJoin(ws: WebSocket, wss: WebSocketServer, data: { name: string }): void {
  const wsId = (ws as any).__id
  const player = addPlayer({ id: wsId } as any, data.name || '玩家')
  wsPlayerMap.set(ws, wsId)
  console.log(`[WS注册] ${wsId} → ${player.name}`)

  // 重连同步
  if (player.roomId) {
    const room = getRoom(player.roomId)
    if (room?.game) {
      send(ws, 'game:sync', {
        phase: room.game.getPhase(),
        hand: room.game.getHands()[player.seat],
        currentTurn: room.game.getCurrentTurn(),
        bankerSeat: room.game.getBankerSeat(),
        multiplier: room.game.getMultiplier(),
        startingSeat: room.game.getStartingSeat(),
      })
    }
  }
}

function handleCreateRoom(ws: WebSocket, wss: WebSocketServer, data: { playerCount: number; debug?: boolean; name?: string }): void {
  const wsId = (ws as any).__id
  let player = getPlayer(wsId)
  if (!player) {
    player = addPlayer({ id: wsId } as any, data.name || '玩家')
    wsPlayerMap.set(ws, wsId)
  } else if (data.name) {
    player.name = data.name
  }

  const pc = Math.max(4, Math.min(6, data.playerCount || 4))
  const room = createRoom(player, pc, data.debug)

  // 调试模式：填充机器人
  if (data.debug) {
    for (let i = room.players.length; i < pc; i++) {
      const botId = `bot_${room.roomCode}_${i}`
      const bot: PlayerConn = {
        socketId: botId, playerId: botId,
        name: BOT_NAMES[i - 1] || `机器${i}`,
        roomId: room.roomCode, seat: i,
        lastHeartbeat: Date.now(), isBot: true,
      }
      room.players.push(bot)
    }
    // 更新 host 玩家的 seat（创建房间时被设为 0）
  }

  send(ws, 'room:created', {
    roomCode: room.roomCode,
    playerCount: pc,
    players: room.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })),
  })
  console.log(`[WS房间] ${player.name} 创建 ${room.roomCode} (${pc}人)${data.debug ? ' [调试]' : ''}`)
}

function handleJoinRoom(ws: WebSocket, wss: WebSocketServer, data: { roomCode: string }): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player) { send(ws, 'error', { message: '请先注册' }); return }

  const result = joinRoom(player, data.roomCode)
  if (!result.ok) { send(ws, 'error', { message: result.reason }); return }

  const room = getRoom(data.roomCode)!
  const playerList = room.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat }))
  broadcastToRoom(wss, data.roomCode, 'room:joined', { roomCode: data.roomCode, players: playerList })
  console.log(`[WS房间] ${player.name} 加入 ${data.roomCode}`)
}

function handleLeaveRoom(ws: WebSocket, wss: WebSocketServer): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player?.roomId) return

  const roomCode = player.roomId
  const room = getRoom(roomCode)
  const history = room?.game?.getRoundHistory() || []
  const playerName = player.name
  const oldPlayers = room?.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })) || []

  leaveRoom(player)

  const updatedRoom = getRoom(roomCode)
  if (updatedRoom) {
    broadcastToRoom(wss, roomCode, 'room:joined', {
      roomCode,
      players: updatedRoom.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })),
    })
  }

  if (history.length > 0) {
    broadcastToRoom(wss, roomCode, 'game:left', { playerName, history, oldPlayers })
  }
}

function handleStartGame(ws: WebSocket, wss: WebSocketServer): void {
  const wsId = (ws as any).__id
  console.log(`[WS开始] 收到请求, wsId=${wsId}`)
  const player = getPlayer(wsId)
  if (!player) { console.log('[WS开始] 玩家不存在'); send(ws, 'error', { message: '玩家不存在' }); return }
  if (!player.roomId) { console.log('[WS开始] 玩家不在房间'); send(ws, 'error', { message: '你不在房间中' }); return }
  console.log(`[WS开始] player=${player.name}, roomId=${player.roomId}`)
  const room = getRoom(player.roomId)
  if (!room) { console.log('[WS开始] 房间不存在'); send(ws, 'error', { message: '房间不存在' }); return }
  console.log(`[WS开始] hostId=${room.hostId}, players=${room.players.length}/${room.playerCount}`)
  if (room.hostId !== wsId) { send(ws, 'error', { message: '只有房主可以开始游戏' }); return }
  if (room.players.length < room.playerCount) { send(ws, 'error', { message: `需要 ${room.playerCount} 人才能开始` }); return }

  try {
    const bus = createWSEventBus(wss, room.roomCode)
    room.game = new Game(room.roomCode, room.playerCount, bus, room.debug)
    console.log(`[WS游戏] ${room.roomCode} 开始`)
    room.game.start()
  } catch (e: any) {
    console.error('[WS游戏] 启动失败:', e.message, e.stack)
    send(ws, 'error', { message: `游戏启动失败: ${e.message}` })
  }
}

function handleBidSubmit(ws: WebSocket, wss: WebSocketServer, data: { bid: Bid & { giveCard?: Card } }): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player?.roomId) return
  const room = getRoom(player.roomId)
  if (!room?.game) return

  const result = room.game.submitBid(player.seat, data.bid)
  if (!result.ok) {
    send(ws, 'error', { message: result.reason })
  }
}

function handlePlaySubmit(ws: WebSocket, wss: WebSocketServer, data: { cards: Card[] }): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player?.roomId) return
  const room = getRoom(player.roomId)
  if (!room?.game) return

  const result = room.game.submitPlay(player.seat, data.cards)
  if (!result.ok) {
    send(ws, 'play:reject', { reason: result.reason })
  }
}

function handlePlayPass(ws: WebSocket, wss: WebSocketServer): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player?.roomId) return
  const room = getRoom(player.roomId)
  if (!room?.game) return

  const result = room.game.pass(player.seat)
  if (!result.ok) {
    send(ws, 'error', { message: result.reason })
  }
}

function handleReady(ws: WebSocket, wss: WebSocketServer): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player?.roomId) return
  const room = getRoom(player.roomId)
  if (!room?.game) return

  room.game.markReady(player.seat)
  for (const p of room.players) {
    if (p.isBot) room.game.markReady(p.seat)
  }
  if (room.game.allReady()) {
    room.game.nextRound()
  }
}

function handleNextRound(ws: WebSocket, wss: WebSocketServer): void {
  const wsId = (ws as any).__id
  const player = getPlayer(wsId)
  if (!player?.roomId) return
  const room = getRoom(player.roomId)
  if (!room?.game) return
  room.game.nextRound()
}

function handleDisconnect(ws: WebSocket, wss: WebSocketServer): void {
  const wsId = (ws as any).__id
  wsPlayerMap.delete(ws)
  const player = removePlayer(wsId)
  if (player?.roomId) {
    const roomCode = player.roomId
    const room = getRoom(roomCode)
    const history = room?.game?.getRoundHistory() || []
    const playerName = player.name
    const oldPlayers = room?.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })) || []

    leaveRoom(player)
    const updatedRoom = getRoom(roomCode)
    if (updatedRoom) {
      broadcastToRoom(wss, roomCode, 'room:joined', {
        roomCode,
        players: updatedRoom.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })),
      })
    }
    if (history.length > 0) {
      broadcastToRoom(wss, roomCode, 'game:left', { playerName, history, oldPlayers })
    }
  }
}

// ─── GameEventBus for raw WebSocket ───

function createWSEventBus(wss: WebSocketServer, roomCode: string): GameEventBus {
  function botDelay(): number { return 400 + Math.random() * 600 }

  function autoBid(rc: string, seat: number, phase: 'charge' | 'request'): void {
    setTimeout(() => {
      const room = getRoom(rc)
      if (!room?.game || room.game.getPhase() !== `bidding-${phase}` || room.game.getCurrentTurn() !== seat) return
      if (phase === 'charge') {
        room.game.submitBid(seat, { type: 'pass', seat })
      } else {
        const hands = room.game.getHands()
        const decision = decideRequestBid({
          seat,
          startingSeat: room.game.getStartingSeat(),
          isFirstGame: room.game.isFirstGame(),
          hand: hands[seat],
          hasHeart4: room.game.hasHeart4(seat),
        })
        if (decision.shouldRequest && decision.card) {
          const result = room.game.submitBid(seat, {
            type: 'request', seat,
            card: decision.card,
            giveCard: decision.giveCard,
          })
          if (!result.ok) {
            if (seat === room.game.getStartingSeat()) {
              const retry = room.game.submitBid(seat, {
                type: 'request', seat, card: decision.card,
              })
              if (!retry.ok) {
                const give = pickGiveCard(hands[seat])
                for (const suit of ['spade', 'heart', 'club', 'diamond'] as Suit[]) {
                  for (const rank of [12, 11, 10, 9, 7, 6, 5, 4]) {
                    if (hands[seat].some((c: Card) => c.suit === suit && c.rank === rank)) continue
                    const r = room.game.submitBid(seat, {
                      type: 'request', seat,
                      card: { suit, rank } as Card,
                      giveCard: give,
                    })
                    if (r.ok) return
                  }
                }
              }
            } else {
              room.game.submitBid(seat, { type: 'pass', seat })
            }
          }
        } else {
          room.game.submitBid(seat, { type: 'pass', seat })
        }
      }
    }, botDelay())
  }

  function autoPlay(rc: string, seat: number): void {
    setTimeout(() => {
      const room = getRoom(rc)
      if (!room?.game || room.game.getPhase() !== 'playing' || room.game.getCurrentTurn() !== seat) return
      const hands = room.game.getHands()
      const hand = hands[seat]
      if (!hand || hand.length === 0) return
      const decision = decidePlay({
        seat,
        bankerSeat: room.game.getBankerSeat(),
        lastPlay: room.game.getLastPlay(),
        lastPlaySeat: room.game.getLastPlaySeat(),
        playerCount: room.game.getPlayerCount(),
        hand,
      })
      if (decision.pass) {
        room.game.pass(seat)
      } else if (decision.cards) {
        const res = room.game.submitPlay(seat, decision.cards)
        if (!res.ok) room.game.pass(seat)
      } else {
        room.game.pass(seat)
      }
    }, botDelay())
  }

  return {
    emitDeal(rc, hands) {
      const room = getRoom(rc)
      if (!room) return
      room.players.forEach((p, i) => {
        if (!p.isBot) {
          sendToSeat(wss, rc, i, 'game:deal', {
            hand: hands[i],
            handCounts: hands.map(h => h.length),
            playerCount: room.playerCount,
            seat: i,
          })
        }
      })
    },
    emitPhase(rc, phase, currentTurn) {
      broadcastToRoom(wss, rc, 'game:phase', { phase, currentTurn })
    },
    emitBidAsk(rc, seat, phase) {
      const room = getRoom(rc)
      if (!room) return
      const p = room.players[seat]
      if (!p) return
      if (p.isBot) {
        autoBid(rc, seat, phase)
        return
      }
      const canPass = phase === 'charge' || seat !== room.game?.getStartingSeat()
      sendToSeat(wss, rc, seat, 'bid:ask', { seat, phase, canPass })
    },
    emitBidResult(rc, bids, bankerSeat, multiplier) {
      broadcastToRoom(wss, rc, 'bid:result', {
        bids: bids.map(b => ({ type: b.type, seat: b.seat, card: b.type === 'request' ? b.card : undefined })),
        bankerSeat,
        multiplier,
      })
    },
    emitCardSwapped(rc, requesterSeat, holderSeat, wantedCard, requesterNewHand, holderNewHand) {
      broadcastToRoom(wss, rc, 'game:card-swapped', { requesterSeat, holderSeat, card: wantedCard })
      sendToSeat(wss, rc, requesterSeat, 'game:hand-update', { hand: requesterNewHand })
      sendToSeat(wss, rc, holderSeat, 'game:hand-update', { hand: holderNewHand })
    },
    emitPlayAsk(rc, seat, comboType, lastPlay) {
      const room = getRoom(rc)
      if (!room) return
      const p = room.players[seat]
      if (!p) return
      if (p.isBot) {
        autoPlay(rc, seat)
        return
      }
      sendToSeat(wss, rc, seat, 'play:ask', {
        seat,
        comboType,
        lastPlay: lastPlay ? { type: lastPlay.type, cards: lastPlay.cards, rank: lastPlay.rank, length: lastPlay.length } : null,
      })
    },
    emitPlayReject(rc, seat, reason) {
      sendToSeat(wss, rc, seat, 'play:reject', { reason })
    },
    emitPlayResult(rc, seat, combo, isPass) {
      broadcastToRoom(wss, rc, 'play:result', {
        seat,
        isPass,
        combo: combo ? { type: combo.type, cards: combo.cards, rank: combo.rank, length: combo.length } : null,
        handCount: getRoom(rc)?.game?.getHands()[seat]?.length ?? 0,
      })
    },
    emitGameOver(rc, bankerWin, payouts, multiplier, bidType, hands) {
      broadcastToRoom(wss, rc, 'game:over', { bankerWin, payouts, multiplier, bidType, hands })
    },
    emitDole(rc, doleSeat, payouts, multiplier) {
      broadcastToRoom(wss, rc, 'game:dole', { doleSeat, payouts, multiplier })
    },
    emitNextRound(rc) {
      broadcastToRoom(wss, rc, 'game:next', {})
    },
  }
}
