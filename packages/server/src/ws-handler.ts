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

const RANK_SEQ = [4, 5, 6, 7, 9, 10, 11, 12, 13]
const RANK_NEXT: Record<number, number | null> = { 4: 5, 5: 6, 6: 7, 7: null, 9: 10, 10: 11, 11: 12, 12: 13, 13: null }

function isSeqConsecutive(ranks: number[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    if (RANK_NEXT[ranks[i - 1]] !== ranks[i]) return false
  }
  return true
}

function groupByRank(hand: Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>()
  for (const c of hand) {
    if (!m.has(c.rank)) m.set(c.rank, [])
    m.get(c.rank)!.push(c)
  }
  return m
}

function pickNewRoundCombo(hand: Card[]): Card[] {
  const byRank = groupByRank(hand)
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b)
  const pairs = sortedRanks.filter(r => byRank.get(r)!.length >= 2)
  if (pairs.length > 0 && Math.random() < 0.4) {
    return byRank.get(pairs[0])!.slice(0, 2)
  }
  const sorted = [...hand].sort((a, b) => a.rank - b.rank)
  return [sorted[0]]
}

function findPlayableCombo(hand: Card[], lastPlay: { type: string; rank: number; length: number }): Card[] | null {
  const byRank = groupByRank(hand)
  const sortedRanksAsc = [...byRank.keys()].sort((a, b) => a - b)

  switch (lastPlay.type) {
    case 'single': {
      const bigger = hand.filter(c => c.rank > lastPlay.rank).sort((a, b) => a.rank - b.rank)
      return bigger.length > 0 ? [bigger[0]] : null
    }
    case 'straight': {
      const len = lastPlay.length
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= lastPlay.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - len + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isSeqConsecutive(neededRanks)) continue
        const combo: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const cards = byRank.get(r)
          if (!cards || cards.length === 0) { ok = false; break }
          combo.push(cards[0])
        }
        if (ok) return combo
      }
      for (const r of sortedRanksAsc) {
        if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
        if (byRank.get(r)!.length >= 3) return byRank.get(r)!.slice(0, 3)
      }
      return null
    }
    case 'pair': {
      for (const r of sortedRanksAsc) {
        if (r > lastPlay.rank && byRank.get(r)!.length >= 2) {
          return byRank.get(r)!.slice(0, 2)
        }
      }
      return null
    }
    case 'double-straight': {
      const pairCount = lastPlay.length / 2
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= lastPlay.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - pairCount + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isSeqConsecutive(neededRanks)) continue
        const combo: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const cards = byRank.get(r)
          if (!cards || cards.length < 2) { ok = false; break }
          combo.push(cards[0], cards[1])
        }
        if (ok) return combo
      }
      for (const r of sortedRanksAsc) {
        if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
        if (byRank.get(r)!.length >= 3) return byRank.get(r)!.slice(0, 3)
      }
      return null
    }
    case 'triple': {
      for (const r of sortedRanksAsc) {
        if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
      }
      for (const r of sortedRanksAsc) {
        if (r > lastPlay.rank && byRank.get(r)!.length >= 3) {
          return byRank.get(r)!.slice(0, 3)
        }
      }
      return null
    }
    case 'quadruple':
      return null
    default:
      return null
  }
}

function createWSEventBus(wss: WebSocketServer, roomCode: string): GameEventBus {
  function botDelay(): number { return 400 + Math.random() * 600 }

  function autoBid(rc: string, seat: number, phase: 'charge' | 'request'): void {
    setTimeout(() => {
      const room = getRoom(rc)
      if (!room?.game || room.game.getPhase() !== `bidding-${phase}` || room.game.getCurrentTurn() !== seat) return
      if (phase === 'charge') {
        room.game.submitBid(seat, { type: 'pass', seat })
      } else {
        const startingSeat = room.game.getStartingSeat()
        const isStarting = seat === startingSeat
        if (!isStarting && Math.random() < 0.6) {
          room.game.submitBid(seat, { type: 'pass', seat })
          return
        }
        const hands = room.game.getHands()
        const ownHand = hands[seat]
        const suits: Suit[] = ['spade', 'heart', 'club', 'diamond']
        const nonKRanks = [4, 5, 6, 7, 9, 10, 11, 12]
        const candidates: Card[] = []
        for (const suit of suits) {
          for (const rank of nonKRanks) {
            if (!ownHand.some(c => c.suit === suit && c.rank === rank)) {
              candidates.push({ suit, rank } as Card)
            }
          }
        }
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }
        let ok = false
        for (const card of candidates) {
          const result = room.game.submitBid(seat, { type: 'request', seat, card: { suit: card.suit, rank: card.rank } })
          if (result.ok) { ok = true; break }
        }
        if (!ok && isStarting) {
          for (const suit of suits) {
            for (const rank of [12, 11] as const) {
              if (ownHand.some(c => c.suit === suit && c.rank === rank)) continue
              const r = room.game.submitBid(seat, { type: 'request', seat, card: { suit, rank } })
              if (r.ok) { ok = true; break }
            }
            if (ok) break
          }
        }
        if (!ok) room.game.submitBid(seat, { type: 'pass', seat })
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
      const lastPlay = room.game.getLastPlay()
      if (lastPlay) {
        if (Math.random() < 0.7) { room.game.pass(seat); return }
        const playable = findPlayableCombo(hand, lastPlay)
        if (playable) {
          const res = room.game.submitPlay(seat, playable)
          if (!res.ok) room.game.pass(seat)
          return
        }
        room.game.pass(seat)
      } else {
        const combo = pickNewRoundCombo(hand)
        room.game.submitPlay(seat, combo)
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
