interface SocketLike { id: string }

export interface PlayerConn {
  socketId: string
  playerId: string
  name: string
  roomId: string | null
  seat: number       // -1 = 未入座
  lastHeartbeat: number
  isBot?: boolean
}

const players = new Map<string, PlayerConn>()

export function addPlayer(socket: SocketLike, name: string): PlayerConn {
  const p: PlayerConn = {
    socketId: socket.id,
    playerId: socket.id,
    name,
    roomId: null,
    seat: -1,
    lastHeartbeat: Date.now(),
  }
  players.set(socket.id, p)
  return p
}

export function getPlayer(socketId: string): PlayerConn | undefined {
  return players.get(socketId)
}

export function removePlayer(socketId: string): PlayerConn | undefined {
  const p = players.get(socketId)
  if (p) players.delete(socketId)
  return p
}

export function heartbeat(socketId: string): void {
  const p = players.get(socketId)
  if (p) p.lastHeartbeat = Date.now()
}
