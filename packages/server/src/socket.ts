import { Server, Socket } from 'socket.io'
import { addPlayer, getPlayer, removePlayer, heartbeat, PlayerConn } from './player'
import { createRoom, getRoom, joinRoom, leaveRoom, getRoomPlayers, deleteRoom } from './room'
import { Game, GameEventBus } from './game'
import { Card, Combo, Bid, Suit } from 'kbao-core'
import { decideRequestBid, decidePlay, pickGiveCard } from './bot-ai'

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
    socket.on('room:create', (data: { playerCount: number; debug?: boolean; openCards?: boolean; name?: string }) => {
      // 确保玩家已注册（兼容 join 事件未到达的情况）
      let player = getPlayer(socket.id)
      if (!player) {
        player = addPlayer(socket, data.name || '玩家')
      } else if (data.name) {
        player.name = data.name
      }

      const pc = Math.max(4, Math.min(6, data.playerCount || 4))
      const isOpenCards = data.openCards || false
      const isDebug = data.debug || false
      const room = createRoom(player, pc, isDebug, isOpenCards)
      socket.join(room.roomCode)

      // 调试/明牌模式：自动填满机器人
      if (isDebug || isOpenCards) {
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
        openCards: isOpenCards,
      })
      console.log(`[房间] ${player.name} 创建 ${room.roomCode} (${pc}人)${isOpenCards ? ' [明牌]' : isDebug ? ' [调试]' : ''}`)
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
      room.game = new Game(room.roomCode, room.playerCount, bus, room.debug, room.openCards)
      console.log(`[游戏] ${room.roomCode} 开始${room.openCards ? ' [明牌]' : ''}`)
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
  function botDelay(type: 'bid' | 'play'): number {
    if (type === 'bid') return 1200 + Math.random() * 800 // 要牌：1.2~2s，出牌2倍
    return 600 + Math.random() * 400 // 出牌：0.6~1s
  }

  function autoBid(roomCode: string, seat: number, phase: 'charge' | 'request'): void {
    setTimeout(() => {
      const room = getRoom(roomCode)
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
            type: 'request',
            seat,
            card: decision.card,
            giveCard: decision.giveCard,
          })
          if (!result.ok) {
            // 要牌被拒绝（极端情况），fallback 为 pass（非起始人）或继续尝试
            if (seat === room.game.getStartingSeat()) {
              // 起始人不能pass，尝试不指定giveCard重试
              const retry = room.game.submitBid(seat, {
                type: 'request', seat, card: decision.card,
              })
              if (!retry.ok) {
                // 最后尝试：选一张手牌中"最没用"的非K牌
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
    }, botDelay('bid'))
  }

  function autoPlay(roomCode: string, seat: number): void {
    setTimeout(() => {
      const room = getRoom(roomCode)
      if (!room?.game || room.game.getPhase() !== 'playing' || room.game.getCurrentTurn() !== seat) return
      const hands = room.game.getHands()
      const hand = hands[seat]
      if (!hand || hand.length === 0) return

      const isOpenCards = room.game.isOpenCards()
      const decision = decidePlay({
        seat,
        bankerSeat: room.game.getBankerSeat(),
        lastPlay: room.game.getLastPlay(),
        lastPlaySeat: room.game.getLastPlaySeat(),
        playerCount: room.game.getPlayerCount(),
        hand,
        handCounts: hands.map(h => h.length),
        // 明牌模式：传人类玩家的手牌给机器人
        humanHands: isOpenCards
          ? room.players
              .filter(p => !p.isBot)
              .map(p => hands[p.seat])
              .flat()
          : undefined,
      })

      if (decision.pass) {
        room.game.pass(seat)
      } else if (decision.cards) {
        const res = room.game.submitPlay(seat, decision.cards)
        if (!res.ok) room.game.pass(seat)
      } else {
        room.game.pass(seat)
      }
    }, botDelay('play'))
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
