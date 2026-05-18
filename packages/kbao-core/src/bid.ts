import { Bid, Card, Rank } from './types'

/**
 * 检查是否可以要这张牌
 * - 不能要 K（rank=13）
 * - 不能要自己手上已有的牌
 * - 不能要本轮已被别人叫过的牌
 */
export function canRequestCard(
  card: Card,
  playerHand: Card[],
  currentRoundBids: Bid[]
): { ok: boolean; reason?: string } {
  if (card.rank === 13) {
    return { ok: false, reason: '不能要K，最高只能要Q' }
  }
  if (playerHand.some(c => c.suit === card.suit && c.rank === card.rank)) {
    return { ok: false, reason: '不能要自己已有的牌' }
  }
  const alreadyRequested = currentRoundBids.some(
    b => b.type === 'request' &&
      b.card.suit === card.suit &&
      b.card.rank === card.rank
  )
  if (alreadyRequested) {
    return { ok: false, reason: '该牌已被别人叫过' }
  }
  return { ok: true }
}

/** 包牌结果 */
export interface BiddingResult {
  phase: 'playing' | 'dole' | 'redeal'
  bankerSeat: number        // -1 表示无庄家
  multiplier: number
}

/**
 * 解析包牌结果
 * @param chargeBids 第一轮（冲）的出价
 * @param requestBids 第二轮（要牌）的出价，如果第一轮有人冲则为空
 * @param startingSeat 起始人座位号
 */
export function resolveBidding(
  chargeBids: Bid[],
  requestBids: Bid[],
  startingSeat: number
): BiddingResult {
  // 第一轮：冲
  const charge = chargeBids.find(b => b.type === 'charge')
  if (charge) {
    return { phase: 'playing', bankerSeat: charge.seat, multiplier: 5 }
  }

  // 第二轮：要牌（起始人必须参与，所以至少有起始人的要牌记录）
  const requests = requestBids.filter(b => b.type === 'request')

  if (requests.length === 0) {
    // 不应发生，但兜底
    return { phase: 'redeal', bankerSeat: -1, multiplier: 0 }
  }

  // 只有起始人一人要 → 吃低保
  if (requests.length === 1 && requests[0].seat === startingSeat) {
    return { phase: 'dole', bankerSeat: startingSeat, multiplier: 1 }
  }

  // 多人要牌 → 最后一个要的当庄
  const lastRequest = requests[requests.length - 1]
  return { phase: 'playing', bankerSeat: lastRequest.seat, multiplier: requests.length }
}

/** 获取下一局的起始人 */
export function nextStartingSeat(currentBankerSeat: number, playerCount: number): number {
  return currentBankerSeat % playerCount
}
