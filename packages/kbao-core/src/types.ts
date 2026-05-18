// ─── 基础类型 ───

export type Suit = 'spade' | 'heart' | 'club' | 'diamond'

// 点数：4-13，其中 11=J, 12=Q, 13=K（不含 2/3/8/A）
export type Rank = 4 | 5 | 6 | 7 | 9 | 10 | 11 | 12 | 13

export const RANK_LABEL: Record<Rank, string> = {
  4: '4', 5: '5', 6: '6', 7: '7',
  9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
}

export const SUIT_LABEL: Record<Suit, string> = {
  spade: '♠',
  heart: '♥',
  club: '♣',
  diamond: '♦',
}

export interface Card {
  suit: Suit
  rank: Rank
}

// ─── 玩家 ───

export interface Player {
  id: string
  name: string
  seat: number        // 座位号 0..N-1
  hand: Card[]
  handCount: number   // 他人可见的剩余牌数
  isBanker: boolean
  isOnline: boolean
}

// ─── 包牌 ───

export type BidType = 'charge' | 'request' | 'pass'

export interface ChargeBid {
  type: 'charge'
  seat: number
}

export interface RequestBid {
  type: 'request'
  seat: number
  card: Card        // 要的牌（点数+花色）
  giveCard?: Card   // 用来交换的手牌（不在 protocol 中则为手牌第一张）
}

export interface PassBid {
  type: 'pass'
  seat: number
}

export type Bid = ChargeBid | RequestBid | PassBid

// ─── 牌型 ───

export type ComboType = 'single' | 'pair' | 'straight' | 'double-straight' | 'triple' | 'quadruple'

export interface Combo {
  type: ComboType
  cards: Card[]
  rank: Rank         // 主牌点数（单张=该牌点数，顺子=最大牌点数）
  length: number     // 顺子/连对的张数长度
}

// ─── 游戏阶段 ───

export type GamePhase = 'bidding-charge' | 'bidding-request' | 'playing' | 'settlement'

// ─── 游戏状态 ───

export interface GameState {
  roomId: string
  phase: GamePhase
  players: Player[]
  playerCount: number
  currentTurn: number        // 当前操作者座位号
  currentComboType: ComboType | null  // 当前需压的牌型（新回合为 null）
  lastPlay: Combo | null     // 桌上最后一手牌
  lastPlaySeat: number | null
  passCount: number          // 连续过牌人数
  passSet: Set<number>       // 本轮已过牌的玩家（用于判断回合结束）
  bidRound: Bid[]            // 当前包牌轮的出价记录
  bidRounds: Bid[][]         // 所有包牌轮（第一轮冲 + 第二轮要牌）
  startingSeat: number       // 本局起始人座位号
  multiplier: number         // 当前局倍数
  roundHistory: RoundResult[]
}

// ─── 结算 ───

export interface RoundResult {
  bankerSeat: number
  bankerWin: boolean
  multiplier: number
  payouts: number[]          // 每人收支（正=赢，负=输），下标为座位号
  bidType: 'charge' | 'request' | 'dole'
}

// ─── 常量 ───

export const ALL_RANKS: Rank[] = [4, 5, 6, 7, 9, 10, 11, 12, 13]

export const ALL_SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond']

// 固定去掉的牌（2、3、8、A 共 16 张）
export const REMOVED_RANKS: number[] = [1, 2, 3, 8] // 1=A
