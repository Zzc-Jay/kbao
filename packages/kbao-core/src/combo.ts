import { Card, Combo, ComboType, Rank, ALL_RANKS } from './types'

// 每张牌的下一个连续点数（null 表示断层）
const NEXT_RANK: Map<Rank, Rank | null> = new Map([
  [4, 5], [5, 6], [6, 7], [7, null],   // 7→9 断层
  [9, 10], [10, 11], [11, 12], [12, 13], [13, null],
])

/** 检查一组点数是否连续（7→9 不允许，中间隔了 8） */
function isConsecutive(ranks: Rank[]): boolean {
  const sorted = [...ranks].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (NEXT_RANK.get(sorted[i - 1]) !== sorted[i]) return false
  }
  return true
}

/** 按点数降序排列 */
function sortByRank(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.rank - a.rank)
}

/**
 * 识别牌型，非法组合返回 null
 */
export function identifyCombo(cards: Card[]): Combo | null {
  if (cards.length === 0) return null

  const sorted = sortByRank(cards)
  const n = sorted.length

  // 1 张：单张
  if (n === 1) {
    return { type: 'single', cards: sorted, rank: sorted[0].rank, length: 1 }
  }

  // 2 张：对子
  if (n === 2) {
    if (sorted[0].rank === sorted[1].rank) {
      return { type: 'pair', cards: sorted, rank: sorted[0].rank, length: 1 }
    }
    return null
  }

  // 3 张
  if (n === 3) {
    if (sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank) {
      return { type: 'triple', cards: sorted, rank: sorted[0].rank, length: 1 }
    }
    // 顺子
    const ranks = sorted.map(c => c.rank) as Rank[]
    if (isConsecutive(ranks)) {
      return { type: 'straight', cards: sorted, rank: sorted[0].rank, length: n }
    }
    return null
  }

  // 4 张
  if (n === 4) {
    // 炸弹
    if (sorted.every(c => c.rank === sorted[0].rank)) {
      return { type: 'quadruple', cards: sorted, rank: sorted[0].rank, length: 1 }
    }
    // 顺子
    const ranks = sorted.map(c => c.rank) as Rank[]
    if (isConsecutive(ranks)) {
      return { type: 'straight', cards: sorted, rank: sorted[0].rank, length: n }
    }
    // 连对（2 对）
    if (isDoubleStraight(sorted)) {
      return { type: 'double-straight', cards: sorted, rank: sorted[0].rank, length: n / 2 }
    }
    return null
  }

  // 5 张及以上
  // 炸弹（同点数不可能超过 4 张）
  if (sorted.every(c => c.rank === sorted[0].rank)) {
    // 最多 4 张同点数，但以防万一
    if (n <= 4) {
      return { type: 'quadruple', cards: sorted, rank: sorted[0].rank, length: 1 }
    }
    return null
  }

  // 顺子
  const ranks = sorted.map(c => c.rank) as Rank[]
  if (isConsecutive(ranks)) {
    return { type: 'straight', cards: sorted, rank: sorted[0].rank, length: n }
  }

  // 连对（偶数张）
  if (n % 2 === 0 && isDoubleStraight(sorted)) {
    return { type: 'double-straight', cards: sorted, rank: sorted[0].rank, length: n / 2 }
  }

  return null
}

/** 判断是否为连对（已排序、偶数张） */
function isDoubleStraight(sorted: Card[]): boolean {
  const n = sorted.length
  if (n < 4 || n % 2 !== 0) return false

  // 每对必须同点数
  const pairRanks: Rank[] = []
  for (let i = 0; i < n; i += 2) {
    if (sorted[i].rank !== sorted[i + 1].rank) return false
    pairRanks.push(sorted[i].rank)
  }

  // 对数至少 2
  if (pairRanks.length < 2) return false

  // 对子之间必须连续
  return isConsecutive(pairRanks)
}

/**
 * 判断新牌型能否压过桌上的牌型
 * lastCombo 为 null 表示新回合，任何合法牌型均可出
 */
export function canBeat(newCombo: Combo, lastCombo: Combo | null): boolean {
  if (lastCombo === null) return true

  // 四张炸弹压一切
  if (newCombo.type === 'quadruple') return true

  // 三张炸弹只能被四张压（已在上面处理）
  if (lastCombo.type === 'quadruple') return false
  if (newCombo.type === 'triple') return true
  if (lastCombo.type === 'triple') return false

  // 同类比较：长度相同，主牌更大
  if (newCombo.type !== lastCombo.type) return false
  if (newCombo.length !== lastCombo.length) return false
  return newCombo.rank > lastCombo.rank
}

/** 获取牌型显示文字 */
export function comboLabel(combo: Combo): string {
  const typeLabel: Record<ComboType, string> = {
    single: '单张',
    pair: '对子',
    straight: '顺子',
    'double-straight': '连对',
    triple: '三张（炸弹）',
    quadruple: '四张（炸弹）',
  }
  return typeLabel[combo.type]
}
