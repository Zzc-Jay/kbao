import { Server, Socket } from 'socket.io'
import { addPlayer, getPlayer, removePlayer, heartbeat, PlayerConn } from './player'
import { createRoom, getRoom, joinRoom, leaveRoom, getRoomPlayers, deleteRoom } from './room'
import { Game, GameEventBus } from './game'
import { Card, Combo, Bid, Suit } from 'kbao-core'

const BOT_NAMES = ['阿泰', '阿和', '老K', '包哥', '小牌']

export function setupSocket(io: Server): void {
  // 心跳定时器
  const heartbeatTimer = setInterval(() => {
    for (const [, socket] of io.of('/').sockets) {
      socket.emit('ping')
    }
  }, 30_000)

  io.on('connection', (socket: Socket) => {
    console.log(`[连接] ${socket.id}`)

    // ─── 注册 ───
    socket.on('join', (data: { name: string }) => {
      const player = addPlayer(socket, data.name || '玩家')
      console.log(`[注册] ${socket.id} → ${player.name}`)

      // 创建事件总线
      const bus = createEventBus(io, socket)

      // 如果该玩家在房间中且游戏正在进行，发同步状态
      if (player.roomId) {
        const room = getRoom(player.roomId)
        if (room?.game) {
          syncGameState(socket, room.game, player.seat)
        }
      }
    })

    // ─── 心跳 ───
    socket.on('pong', () => {
      heartbeat(socket.id)
    })

    // ─── 房间：创建 ───
    socket.on('room:create', (data: { playerCount: number; debug?: boolean; name?: string }) => {
      // 确保玩家已注册（兼容 join 事件未到达的情况）
      let player = getPlayer(socket.id)
      if (!player) {
        player = addPlayer(socket, data.name || '玩家')
      } else if (data.name) {
        player.name = data.name
      }

      const pc = Math.max(4, Math.min(6, data.playerCount || 4))
      const room = createRoom(player, pc, data.debug)
      socket.join(room.roomCode)

      // 调试模式：自动填满机器人
      if (data.debug) {
        for (let i = room.players.length; i < pc; i++) {
          const botId = `bot_${room.roomCode}_${i}`
          const bot: PlayerConn = {
            socketId: botId,
            playerId: botId,
            name: BOT_NAMES[i - 1] || `机器${i}`,
            roomId: room.roomCode,
            seat: i,
            lastHeartbeat: Date.now(),
            isBot: true,
          }
          room.players.push(bot)
        }
      }

      socket.emit('room:created', {
        roomCode: room.roomCode,
        playerCount: pc,
        players: room.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })),
      })
      console.log(`[房间] ${player.name} 创建 ${room.roomCode} (${pc}人)${data.debug ? ' [调试]' : ''}`)
    })

    // ─── 房间：加入 ───
    socket.on('room:join', (data: { roomCode: string }) => {
      const player = getPlayer(socket.id)
      if (!player) return

      const result = joinRoom(player, data.roomCode)
      if (!result.ok) {
        socket.emit('error', { message: result.reason })
        return
      }

      socket.join(data.roomCode)
      const room = getRoom(data.roomCode)!
      const playerList = room.players.map(p => ({
        id: p.socketId, name: p.name, seat: p.seat,
      }))
      io.to(data.roomCode).emit('room:joined', { roomCode: data.roomCode, players: playerList })
      console.log(`[房间] ${player.name} 加入 ${data.roomCode}`)
    })

    // ─── 房间：离开 ───
    socket.on('room:leave', () => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const roomCode = player.roomId
      const room = getRoom(roomCode)
      const history = room?.game?.getRoundHistory() || []
      const playerName = player.name
      // 记录离开前的玩家信息（用于客户端映射旧座位号）
      const oldPlayers = room?.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })) || []

      leaveRoom(player)
      socket.leave(roomCode)

      const updatedRoom = getRoom(roomCode)
      if (updatedRoom) {
        io.to(roomCode).emit('room:joined', {
          roomCode,
          players: updatedRoom.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })),
        })
      }

      // 游戏中有玩家退出，通知所有人（附带旧座位映射）
      if (history.length > 0) {
        io.to(roomCode).emit('game:left', { playerName, history, oldPlayers })
      }
    })

    // ─── 开始游戏 ───
    socket.on('room:start', () => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const room = getRoom(player.roomId)
      if (!room) return
      if (room.hostId !== socket.id) {
        socket.emit('error', { message: '只有房主可以开始游戏' })
        return
      }
      if (room.players.length < room.playerCount) {
        socket.emit('error', { message: `需要 ${room.playerCount} 人才能开始` })
        return
      }

      const bus = createEventBus(io, socket)
      room.game = new Game(room.roomCode, room.playerCount, bus, room.debug)
      console.log(`[游戏] ${room.roomCode} 开始`)
      room.game.start()
    })

    // ─── 包牌：提交 ───
    socket.on('bid:submit', (data: { bid: Bid & { giveCard?: Card } }) => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const room = getRoom(player.roomId)
      if (!room?.game) return

      const result = room.game.submitBid(player.seat, data.bid)
      if (!result.ok) {
        socket.emit('error', { message: result.reason })
      }
    })

    // ─── 出牌：提交 ───
    socket.on('play:submit', (data: { cards: Card[] }) => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const room = getRoom(player.roomId)
      if (!room?.game) return

      const result = room.game.submitPlay(player.seat, data.cards)
      if (!result.ok) {
        socket.emit('play:reject', { reason: result.reason })
      }
    })

    // ─── 出牌：过 ───
    socket.on('play:pass', () => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const room = getRoom(player.roomId)
      if (!room?.game) return

      const result = room.game.pass(player.seat)
      if (!result.ok) {
        socket.emit('error', { message: result.reason })
      }
    })

    // ─── 准备 ───
    socket.on('game:ready', () => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const room = getRoom(player.roomId)
      if (!room?.game) return

      room.game.markReady(player.seat)

      // 机器人自动准备
      for (const p of room.players) {
        if (p.isBot) room.game.markReady(p.seat)
      }

      if (room.game.allReady()) {
        room.game.nextRound()
      }
    })

    // ─── 下一局 ───
    socket.on('game:next', () => {
      const player = getPlayer(socket.id)
      if (!player?.roomId) return

      const room = getRoom(player.roomId)
      if (!room?.game) return

      room.game.nextRound()
    })

    // ─── 断线 ───
    socket.on('disconnect', () => {
      console.log(`[断线] ${socket.id}`)
      const player = removePlayer(socket.id)
      if (player?.roomId) {
        const roomCode = player.roomId
        const room = getRoom(roomCode)
        const history = room?.game?.getRoundHistory() || []
        const playerName = player.name
        const oldPlayers = room?.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })) || []

        leaveRoom(player)
        const updatedRoom = getRoom(roomCode)
        if (updatedRoom) {
          io.to(roomCode).emit('room:joined', {
            roomCode,
            players: updatedRoom.players.map(p => ({ id: p.socketId, name: p.name, seat: p.seat })),
          })
        }

        if (history.length > 0) {
          io.to(roomCode).emit('game:left', { playerName, history, oldPlayers })
        }
      }
    })
  })
}

// ─── 事件总线（Game → Socket.IO）───

function createEventBus(io: Server, _socket: Socket): GameEventBus {
  function botDelay(): number {
    return 400 + Math.random() * 600 // 0.4~1秒，模拟思考
  }

  function autoBid(roomCode: string, seat: number, phase: 'charge' | 'request'): void {
    setTimeout(() => {
      const room = getRoom(roomCode)
      if (!room?.game || room.game.getPhase() !== `bidding-${phase}` || room.game.getCurrentTurn() !== seat) return

      if (phase === 'charge') {
        room.game.submitBid(seat, { type: 'pass', seat })
      } else {
        const startingSeat = room.game.getStartingSeat()
        const isStarting = seat === startingSeat

        // 非起始人：60% 概率直接过
        if (!isStarting && Math.random() < 0.6) {
          room.game.submitBid(seat, { type: 'pass', seat })
          return
        }

        // 生成牌组中所有可能的非K牌（4花色 × 8点数 = 32张），排除自己手上已有的
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
        // 随机打乱
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }

        let ok = false
        for (const card of candidates) {
          const result = room.game.submitBid(seat, { type: 'request', seat, card: { suit: card.suit, rank: card.rank } })
          if (result.ok) { ok = true; break }
        }
        // 起始人不能过：所有候选都失败时（极端情况），尝试 Q 和 J
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

  function autoPlay(roomCode: string, seat: number): void {
    setTimeout(() => {
      const room = getRoom(roomCode)
      if (!room?.game || room.game.getPhase() !== 'playing' || room.game.getCurrentTurn() !== seat) return
      const hands = room.game.getHands()
      const hand = hands[seat]
      if (!hand || hand.length === 0) return

      const lastPlay = room.game.getLastPlay()

      if (lastPlay) {
        // 可以过牌 → 机器人喜欢过牌
        if (Math.random() < 0.7) {
          room.game.pass(seat)
          return
        }
        const playable = findPlayableCombo(hand, lastPlay)
        if (playable) {
          const res = room.game.submitPlay(seat, playable)
          if (!res.ok) room.game.pass(seat)
          return
        }
        room.game.pass(seat)
      } else {
        // 新回合，必须出牌
        const combo = pickNewRoundCombo(hand)
        room.game.submitPlay(seat, combo)
      }
    }, botDelay())
  }

  return {
    emitDeal(roomCode, hands) {
      const room = getRoom(roomCode)
      if (!room) return
      room.players.forEach((p, i) => {
        if (!p.isBot) {
          io.to(p.socketId).emit('game:deal', {
            hand: hands[i],
            handCounts: hands.map(h => h.length),
            playerCount: room.playerCount,
            seat: i,
          })
        }
      })
    },

    emitPhase(roomCode, phase, currentTurn) {
      io.to(roomCode).emit('game:phase', { phase, currentTurn })
    },

    emitBidAsk(roomCode, seat, phase) {
      const room = getRoom(roomCode)
      if (!room) return
      const p = room.players[seat]
      if (!p) return
      if (p.isBot) {
        autoBid(roomCode, seat, phase)
        return
      }
      const canPass = phase === 'charge' || seat !== room.game?.getStartingSeat()
      io.to(p.socketId).emit('bid:ask', { seat, phase, canPass })
    },

    emitBidResult(roomCode, bids, bankerSeat, multiplier) {
      io.to(roomCode).emit('bid:result', {
        bids: bids.map(b => ({
          type: b.type,
          seat: b.seat,
          card: b.type === 'request' ? b.card : undefined,
        })),
        bankerSeat,
        multiplier,
      })
    },

    emitCardSwapped(roomCode, requesterSeat, holderSeat, wantedCard, requesterNewHand, holderNewHand) {
      const room = getRoom(roomCode)
      if (!room) return
      // 公开广播：谁要了谁的什么牌（花色+数字可见）
      io.to(roomCode).emit('game:card-swapped', {
        requesterSeat,
        holderSeat,
        card: wantedCard,        // 要的目标牌 — 公开
        // 不给 giveCard 信息 — 给出去的牌保密
      })
      // 私下发送：要牌者收到自己新手牌
      const rp = room.players[requesterSeat]
      if (rp && !rp.isBot) {
        io.to(rp.socketId).emit('game:hand-update', { hand: requesterNewHand })
      }
      // 私下发送：被要牌者收到自己新手牌
      const hp = room.players[holderSeat]
      if (hp && !hp.isBot) {
        io.to(hp.socketId).emit('game:hand-update', { hand: holderNewHand })
      }
    },

    emitPlayAsk(roomCode, seat, comboType, lastPlay) {
      const room = getRoom(roomCode)
      if (!room) return
      const p = room.players[seat]
      if (!p) return
      if (p.isBot) {
        autoPlay(roomCode, seat)
        return
      }
      io.to(p.socketId).emit('play:ask', {
        seat,
        comboType,
        lastPlay: lastPlay ? { type: lastPlay.type, cards: lastPlay.cards, rank: lastPlay.rank, length: lastPlay.length } : null,
      })
    },

    emitPlayReject(roomCode, seat, reason) {
      const room = getRoom(roomCode)
      if (!room) return
      const p = room.players[seat]
      if (p && !p.isBot) io.to(p.socketId).emit('play:reject', { reason })
    },

    emitPlayResult(roomCode, seat, combo, isPass) {
      io.to(roomCode).emit('play:result', {
        seat,
        isPass,
        combo: combo ? { type: combo.type, cards: combo.cards, rank: combo.rank, length: combo.length } : null,
        handCount: getRoom(roomCode)?.game?.getHands()[seat]?.length ?? 0,
      })
    },

    emitGameOver(roomCode, bankerWin, payouts, multiplier, bidType, hands) {
      io.to(roomCode).emit('game:over', { bankerWin, payouts, multiplier, bidType, hands })
    },

    emitDole(roomCode, doleSeat, payouts, multiplier) {
      io.to(roomCode).emit('game:dole', { doleSeat, payouts, multiplier })
    },

    emitNextRound(roomCode) {
      io.to(roomCode).emit('game:next')
    },
  }
}

const RANK_SEQ = [4, 5, 6, 7, 9, 10, 11, 12, 13]
const RANK_NEXT: Record<number, number | null> = {4:5, 5:6, 6:7, 7:null, 9:10, 10:11, 11:12, 12:13, 13:null}

function isSeqConsecutive(ranks: number[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    if (RANK_NEXT[ranks[i - 1]] !== ranks[i]) return false
  }
  return true
}

/** 按点数分组（用于找对子/炸弹） */
function groupByRank(hand: Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>()
  for (const c of hand) {
    if (!m.has(c.rank)) m.set(c.rank, [])
    m.get(c.rank)!.push(c)
  }
  return m
}

/** 新回合挑一组最小的合法牌型出 */
function pickNewRoundCombo(hand: Card[]): Card[] {
  const byRank = groupByRank(hand)
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b)

  // 有机会就出最小的对子
  const pairs = sortedRanks.filter(r => byRank.get(r)!.length >= 2)
  if (pairs.length > 0 && Math.random() < 0.4) {
    return byRank.get(pairs[0])!.slice(0, 2)
  }
  // 默认出最小的单张
  const sorted = [...hand].sort((a, b) => a.rank - b.rank)
  return [sorted[0]]
}

/** 在手牌中找到能管上 lastPlay 的牌型 */
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
      // 炸弹压顺子
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
      // 炸弹压连对
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

function syncGameState(socket: Socket, game: Game, seat: number): void {
  socket.emit('game:sync', {
    phase: game.getPhase(),
    hand: game.getHands()[seat],
    currentTurn: game.getCurrentTurn(),
    bankerSeat: game.getBankerSeat(),
    multiplier: game.getMultiplier(),
    startingSeat: game.getStartingSeat(),
  })
}
