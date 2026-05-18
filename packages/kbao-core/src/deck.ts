import { Card, Suit, Rank, Player, ALL_RANKS, ALL_SUITS } from './types'

/**
 * 创建一副 K 包牌（去掉 2/3/8/A，共 36 张）
 * playerCount=5 时额外随机去掉一张 K（剩 35 张）
 */
export function createDeck(playerCount: number): Card[] {
  const deck: Card[] = []
  for (const suit of ALL_SUITS) {
    for (const rank of ALL_RANKS) {
      deck.push({ suit, rank })
    }
  }
  // 5 人局随机去掉一张 K
  if (playerCount === 5) {
    const kCards = deck.filter(c => c.rank === 13)
    const remove = kCards[Math.floor(Math.random() * kCards.length)]
    const idx = deck.indexOf(remove)
    deck.splice(idx, 1)
  }
  return deck
}

/** Fisher-Yates 洗牌 */
export function shuffle(deck: Card[]): Card[] {
  const d = [...deck]
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

/**
 * 发牌：每人等量
 * 返回每人一份的数组，下标即座位号
 */
export function deal(deck: Card[], playerCount: number): Card[][] {
  const perHand = Math.floor(deck.length / playerCount)
  const hands: Card[][] = Array.from({ length: playerCount }, () => [])
  for (let i = 0; i < deck.length && i < perHand * playerCount; i++) {
    hands[i % playerCount].push(deck[i])
  }
  // 每人手牌按点数排序（方便查看）
  for (const hand of hands) {
    hand.sort((a, b) => b.rank - a.rank)
  }
  return hands
}

/** 找到红心 4 的持有者座位号 */
export function findStartingPlayer(hands: Card[][]): number {
  return hands.findIndex(hand =>
    hand.some(c => c.suit === 'heart' && c.rank === 4)
  )
}
