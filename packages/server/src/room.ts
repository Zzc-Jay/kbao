import { PlayerConn } from './player'
import { Game } from './game'

export interface Room {
  roomCode: string
  hostId: string
  playerCount: number      // 房间设定人数
  players: PlayerConn[]    // 按座位号排列
  game: Game | null
  createdAt: number
  debug: boolean            // 调试模式
}

const rooms = new Map<string, Room>()

function genCode(): string {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000))
    if (!rooms.has(code)) return code
  }
}

export function createRoom(host: PlayerConn, playerCount: number, debug = false): Room {
  const room: Room = {
    roomCode: genCode(),
    hostId: host.socketId,
    playerCount,
    players: [host],
    game: null,
    createdAt: Date.now(),
    debug,
  }
  host.roomId = room.roomCode
  host.seat = 0
  rooms.set(room.roomCode, room)
  return room
}

export function getRoom(roomCode: string): Room | undefined {
  return rooms.get(roomCode)
}

export function joinRoom(player: PlayerConn, roomCode: string): { ok: boolean; reason?: string } {
  const room = rooms.get(roomCode)
  if (!room) return { ok: false, reason: '房间不存在' }
  if (room.players.length >= room.playerCount) return { ok: false, reason: '房间已满' }
  if (room.game) return { ok: false, reason: '游戏已开始' }
  if (room.players.some(p => p.socketId === player.socketId)) return { ok: false, reason: '你已在房间中' }

  player.roomId = roomCode
  player.seat = room.players.length
  room.players.push(player)
  return { ok: true }
}

export function leaveRoom(player: PlayerConn): void {
  const room = player.roomId ? rooms.get(player.roomId) : undefined
  if (!room) return

  const idx = room.players.findIndex(p => p.socketId === player.socketId)
  if (idx >= 0) room.players.splice(idx, 1)

  player.roomId = null
  player.seat = -1

  if (room.players.length === 0) {
    rooms.delete(room.roomCode)
    return
  }

  // 重置座位号
  room.players.forEach((p, i) => { p.seat = i })

  // 房主离开则转移给下一位
  if (player.socketId === room.hostId) {
    room.hostId = room.players[0].socketId
  }
}

export function getRoomPlayers(roomCode: string): PlayerConn[] {
  const room = rooms.get(roomCode)
  return room ? [...room.players] : []
}

export function deleteRoom(roomCode: string): void {
  rooms.delete(roomCode)
}
