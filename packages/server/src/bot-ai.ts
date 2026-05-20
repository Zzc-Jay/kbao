/**
 * 机器人 AI 模块 — 手牌分析 + 出牌决策
 *
 * 核心策略：
 * - 庄家：尽快出完手牌，优先长顺子、连对，保留炸弹用于夺回出牌权
 * - 非庄家（盟友）：拦截庄家，不拦截盟友（除非自己牌极好）
 * - 炸弹：90% 用于拦截，10% 保留到下回合
 * - 要牌：红心4 100% 要牌；要牌时给出手牌中最没用的小牌（非K）
 */

import { Card, Combo, Suit, Rank } from 'kbao-core'

// ==================== 常量 ====================

const RANK_SEQ: number[] = [4, 5, 6, 7, 9, 10, 11, 12, 13]
const RANK_NEXT: Record<number, number | null> = { 4: 5, 5: 6, 6: 7, 7: null, 9: 10, 10: 11, 11: 12, 12: 13, 13: null }
const SUITS: Suit[] = ['spade', 'heart', 'club', 'diamond']

// ==================== 基础工具 ====================

/** 按点数降序排列 */
export function sortByRank(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.rank - a.rank)
}

/** 按点数升序排列 */
function sortByRankAsc(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => a.rank - b.rank)
}

/** 按点数分组 */
function groupByRank(hand: Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>()
  for (const c of hand) {
    if (!m.has(c.rank)) m.set(c.rank, [])
    m.get(c.rank)!.push(c)
  }
  return m
}

/** 检查点数序列是否连续 */
function isConsecutive(ranks: number[]): boolean {
  for (let i = 1; i < ranks.length; i++) {
    if (RANK_NEXT[ranks[i - 1]] !== ranks[i]) return false
  }
  return true
}

// ==================== 手牌分析 ====================

export interface HandAnalysis {
  byRank: Map<number, Card[]>
  sortedRanks: number[]         // 升序
  pairs: number[]               // >=2张的点数
  triples: number[]             // >=3张的点数
  bombRanks: number[]           // 4张的点数
  straights: StraightOption[]   // 所有可能的顺子
  doubleStraights: DSOption[]   // 所有可能的连对
  minPlays: number              // 最少出牌次数（含炸弹战术价值）
  quality: 'excellent' | 'good' | 'average' | 'poor'
}

interface StraightOption {
  ranks: number[]
  length: number
  maxRank: number
}

interface DSOption {
  ranks: number[]
  pairCount: number
  maxRank: number
}

/**
 * 分析手牌结构
 */
export function analyzeHand(hand: Card[]): HandAnalysis {
  const byRank = groupByRank(hand)
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b)

  const pairs = sortedRanks.filter(r => byRank.get(r)!.length >= 2)
  const triples = sortedRanks.filter(r => byRank.get(r)!.length >= 3)
  const bombRanks = sortedRanks.filter(r => byRank.get(r)!.length === 4)

  const straights = findStraights(byRank)
  const doubleStraights = findDoubleStraights(byRank)
  const minPlays = calcMinPlays(byRank, straights, doubleStraights)

  // 手牌质量评估
  let quality: HandAnalysis['quality'] = 'average'
  const totalCards = hand.length
  if (minPlays <= 3) quality = 'excellent'
  else if (minPlays <= totalCards * 0.4) quality = 'good'
  else if (minPlays <= totalCards * 0.6) quality = 'average'
  else quality = 'poor'

  return { byRank, sortedRanks, pairs, triples, bombRanks, straights, doubleStraights, minPlays, quality }
}

/** 查找所有可能的顺子 */
function findStraights(byRank: Map<number, Card[]>): StraightOption[] {
  const results: StraightOption[] = []
  const segments = [[4, 5, 6, 7], [9, 10, 11, 12, 13]]

  for (const seg of segments) {
    for (let startIdx = 0; startIdx < seg.length; startIdx++) {
      for (let endIdx = startIdx + 2; endIdx < seg.length; endIdx++) {
        const ranks = seg.slice(startIdx, endIdx + 1)
        if (ranks.every(r => (byRank.get(r)?.length ?? 0) >= 1)) {
          results.push({ ranks, length: ranks.length, maxRank: ranks[ranks.length - 1] })
        } else {
          break
        }
      }
    }
  }
  return results
}

/** 查找所有可能的连对 */
function findDoubleStraights(byRank: Map<number, Card[]>): DSOption[] {
  const results: DSOption[] = []
  const segments = [[4, 5, 6, 7], [9, 10, 11, 12, 13]]

  for (const seg of segments) {
    for (let startIdx = 0; startIdx < seg.length; startIdx++) {
      for (let endIdx = startIdx + 1; endIdx < seg.length; endIdx++) {
        const ranks = seg.slice(startIdx, endIdx + 1)
        if (ranks.every(r => (byRank.get(r)?.length ?? 0) >= 2)) {
          results.push({ ranks, pairCount: ranks.length, maxRank: ranks[ranks.length - 1] })
        } else {
          break
        }
      }
    }
  }
  return results
}

/**
 * 计算最少出牌次数
 * 使用贪心+枚举：尝试每种顺子组合，选最优分解
 */
function calcMinPlays(
  byRank: Map<number, Card[]>,
  straights: StraightOption[],
  doubleStraights: DSOption[]
): number {
  const totalCards = [...byRank.values()].reduce((s, c) => s + c.length, 0)
  let best = totalCards // 全部出单张

  // 尝试：不出顺子、出每条顺子
  const candidates: StraightOption[][] = [[]]
  for (const s of straights) {
    candidates.push([s])
  }
  // 尝试同时出两条顺子（不同段）
  const seg1 = straights.filter(s => s.ranks[0] <= 7)
  const seg2 = straights.filter(s => s.ranks[0] >= 9)
  for (const s1 of seg1) {
    for (const s2 of seg2) {
      candidates.push([s1, s2])
    }
  }

  for (const chosenStraights of candidates) {
    // 检查顺子是否冲突（同张牌不能用于两个顺子）
    const used = new Map<number, number>() // rank → count used
    for (const s of chosenStraights) {
      for (const r of s.ranks) {
        used.set(r, (used.get(r) || 0) + 1)
      }
    }
    let conflict = false
    for (const [r, cnt] of used) {
      if (cnt > (byRank.get(r)?.length ?? 0)) { conflict = true; break }
    }
    if (conflict) continue

    const remaining = new Map<number, number>()
    for (const [r, cards] of byRank) {
      const cnt = cards.length - (used.get(r) || 0)
      if (cnt > 0) remaining.set(r, cnt)
    }

    let plays = chosenStraights.length // 每条顺子算一手

    // 再从剩余牌中找连对
    // 简化：从剩余牌中尝试找最优分解
    const remainingPlays = countRemainingPlays(remaining)
    plays += remainingPlays

    if (plays < best) best = plays
  }

  return best
}

/** 计算剩余牌的最优出牌次数（贪心：优先连对→对子→单张） */
function countRemainingPlays(remaining: Map<number, number>): number {
  const counts = new Map(remaining)
  let plays = 0

  // 形成对子 + 单张
  for (const [rank, cnt] of counts) {
    if (cnt >= 2) {
      plays += Math.floor(cnt / 2) // 每2张=1手对子
      const leftover = cnt % 2
      if (leftover > 0) plays += leftover // 剩余单张
    } else if (cnt > 0) {
      plays += 1 // 单张
    }
  }

  return plays
}

// ==================== 出牌选择 ====================

/**
 * 新回合：选择最佳开局牌型
 * @param isBanker 自己是否为庄家
 * @param bankerRemaining 庄家剩余牌数
 */
function pickOpeningCombo(analysis: HandAnalysis, isBanker: boolean, bankerRemaining: number): Card[] {
  const { byRank, straights, doubleStraights, pairs, bombRanks } = analysis

  // 自己快赢了 → 直接出完
  const myCards = [...byRank.values()].flat()
  if (myCards.length <= 2) {
    if (myCards.length === 2 && myCards[0].rank === myCards[1].rank) {
      return myCards // 对子直接出
    }
    return [sortByRankAsc(myCards)[0]] // 出最小的单张
  }

  // 庄家残血 → 出大牌压制，不给庄家接牌机会
  if (!isBanker && bankerRemaining <= 3) {
    return pickBigOpening(analysis)
  }

  // 1. 优先出最长顺子（只消耗每点数1张，不破坏炸弹）
  if (straights.length > 0) {
    const best = straights.reduce((a, b) => b.length >= a.length ? b : a)
    const combo: Card[] = []
    for (const r of best.ranks) {
      combo.push(byRank.get(r)![0])
    }
    return combo
  }

  // 2. 其次连对（需评估拆炸弹的代价）
  if (doubleStraights.length > 0) {
    const sorted = [...doubleStraights].sort((a, b) => b.pairCount - a.pairCount)
    for (const ds of sorted) {
      const bombBreakCount = ds.ranks.filter(r => bombRanks.includes(r)).length
      if (bombBreakCount >= 1 && ds.pairCount < 3) continue
      const combo: Card[] = []
      for (const r of ds.ranks) {
        combo.push(byRank.get(r)![0], byRank.get(r)![1])
      }
      return combo
    }
  }

  // 3. 出最小的对子（避开炸弹点数）
  const nonBombPairs = pairs.filter(r => !bombRanks.includes(r))
  if (nonBombPairs.length > 0) {
    return byRank.get(nonBombPairs[0])!.slice(0, 2)
  }
  if (pairs.length > 0) {
    return byRank.get(pairs[0])!.slice(0, 2)
  }

  // 4. 庄家牌不多时出大单张压制
  if (!isBanker && bankerRemaining <= 5) {
    return [sortByRank([...byRank.values()].flat())[0]]
  }

  // 5. 正常情况出最小的单张
  const allCards = [...byRank.values()].flat()
  const nonBombCards = allCards.filter(c => !bombRanks.includes(c.rank))
  const pick = nonBombCards.length > 0 ? nonBombCards : allCards
  return [sortByRankAsc(pick)[0]]
}

/**
 * 庄家残血时，开局出大牌压制
 */
function pickBigOpening(analysis: HandAnalysis): Card[] {
  const { byRank, doubleStraights, pairs } = analysis

  // 大顺子优先
  const bigStraights = analysis.straights.filter(s => s.maxRank >= 11)
  if (bigStraights.length > 0) {
    const best = bigStraights.reduce((a, b) => b.maxRank >= a.maxRank ? b : a)
    const combo: Card[] = []
    for (const r of best.ranks) combo.push(byRank.get(r)![0])
    return combo
  }

  // 大连对
  if (doubleStraights.length > 0) {
    const best = doubleStraights.reduce((a, b) => b.maxRank >= a.maxRank ? b : a)
    const combo: Card[] = []
    for (const r of best.ranks) combo.push(byRank.get(r)![0], byRank.get(r)![1])
    return combo
  }

  // 最大的对子
  if (pairs.length > 0) {
    const maxPair = pairs[pairs.length - 1]
    return byRank.get(maxPair)!.slice(0, 2)
  }

  // 最大的单张
  return [sortByRank([...byRank.values()].flat())[0]]
}

/**
 * 找到能压过 lastPlay 的最小牌型
 * 如果 lastPlay 来自盟友且自己牌一般 → 返回 null（不压）
 */
function findSmallestBeat(
  analysis: HandAnalysis,
  lastPlay: Combo,
  isAlly: boolean
): Card[] | null {
  const { byRank, sortedRanks, bombRanks } = analysis

  const result = findBeatWithoutBomb(byRank, sortedRanks, lastPlay)
  if (result) return result

  // 常规牌型管不上 → 考虑用炸弹
  // 如果是盟友且自己牌不是极好 → 不炸
  if (isAlly && analysis.quality !== 'excellent') return null

  // 用三张炸弹或四张炸弹
  return findBombBeat(byRank, sortedRanks, bombRanks, lastPlay)
}

/** 不用炸弹找到能管上的最小牌型 */
function findBeatWithoutBomb(
  byRank: Map<number, Card[]>,
  sortedRanksAsc: number[],
  lastPlay: Combo
): Card[] | null {
  switch (lastPlay.type) {
    case 'single': {
      for (const r of sortedRanksAsc) {
        if (r > lastPlay.rank) return [byRank.get(r)![0]]
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
    case 'straight': {
      const len = lastPlay.length
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= lastPlay.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - len + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isConsecutive(neededRanks)) continue
        const combo: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const cards = byRank.get(r)
          if (!cards || cards.length === 0) { ok = false; break }
          combo.push(cards[0])
        }
        if (ok) return combo
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
        if (!isConsecutive(neededRanks)) continue
        const combo: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const cards = byRank.get(r)
          if (!cards || cards.length < 2) { ok = false; break }
          combo.push(cards[0], cards[1])
        }
        if (ok) return combo
      }
      return null
    }
    case 'triple': {
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

/** 用炸弹管上 */
function findBombBeat(
  byRank: Map<number, Card[]>,
  sortedRanksAsc: number[],
  bombRanks: number[],
  lastPlay: Combo
): Card[] | null {
  // 四张炸弹可以压任何牌
  for (const r of sortedRanksAsc) {
    if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
  }
  // 如果 lastPlay 不是炸弹，三张也能压
  if (lastPlay.type !== 'triple' && lastPlay.type !== 'quadruple') {
    for (const r of sortedRanksAsc) {
      if (byRank.get(r)!.length >= 3) return byRank.get(r)!.slice(0, 3)
    }
  }
  // 三张只能被更大的三张或四张压
  if (lastPlay.type === 'triple') {
    for (const r of sortedRanksAsc) {
      if (r > lastPlay.rank && byRank.get(r)!.length >= 3) {
        return byRank.get(r)!.slice(0, 3)
      }
    }
  }
  return null
}

/**
 * 检查出牌后手牌是否更优（炸弹拆开是否值得）
 * 如果拆炸弹能形成更优的出牌序列，返回 true
 */
function shouldBreakBomb(
  analysis: HandAnalysis,
  needStraight: boolean,
  needPair: boolean
): boolean {
  if (analysis.bombRanks.length === 0) return false

  // 如果手牌质量已经很好，不要拆炸弹
  if (analysis.quality === 'excellent') return false

  // 如果急需顺子且拆炸能形成顺子
  if (needStraight) {
    for (const bombRank of analysis.bombRanks) {
      // 检查这个炸弹拆开后能否用于形成顺子
      for (const s of analysis.straights) {
        if (s.ranks.includes(bombRank) && s.length >= 3) {
          return true
        }
      }
    }
  }

  // 如果急需对子且拆炸能形成多个对子
  if (needPair && analysis.pairs.length <= 1 && analysis.bombRanks.length >= 1) {
    return true
  }

  return false
}

// ==================== 明牌模式辅助 ====================

/**
 * 检查玩家能否管上给定的牌型
 */
function canPlayerBeat(playerHand: Card[], combo: Combo): boolean {
  return findPlayerBeat(playerHand, combo) !== null
}

/**
 * 找玩家手牌中能管上 combo 的任意牌型
 */
function findPlayerBeat(playerHand: Card[], combo: Combo): Card[] | null {
  const byRank = groupByRank(playerHand)
  const sortedRanks = [...byRank.keys()].sort((a, b) => a - b)

  switch (combo.type) {
    case 'single': {
      for (const r of sortedRanks) {
        if (r > combo.rank) return [byRank.get(r)![0]]
      }
      return null
    }
    case 'pair': {
      for (const r of sortedRanks) {
        if (r > combo.rank && byRank.get(r)!.length >= 2) {
          return byRank.get(r)!.slice(0, 2)
        }
      }
      return null
    }
    case 'straight': {
      const len = combo.length
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= combo.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - len + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isConsecutive(neededRanks)) continue
        const cards: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const c = byRank.get(r)
          if (!c || c.length === 0) { ok = false; break }
          cards.push(c[0])
        }
        if (ok) return cards
      }
      // check bombs (straights can be beaten by triple or quad bombs)
      for (const r of sortedRanks) {
        if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
        if (byRank.get(r)!.length >= 3) return byRank.get(r)!.slice(0, 3)
      }
      return null
    }
    case 'double-straight': {
      const pairCount = combo.length / 2
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= combo.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - pairCount + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isConsecutive(neededRanks)) continue
        const cards: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const c = byRank.get(r)
          if (!c || c.length < 2) { ok = false; break }
          cards.push(c[0], c[1])
        }
        if (ok) return cards
      }
      for (const r of sortedRanks) {
        if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
        if (byRank.get(r)!.length >= 3) return byRank.get(r)!.slice(0, 3)
      }
      return null
    }
    case 'triple': {
      for (const r of sortedRanks) {
        if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
      }
      for (const r of sortedRanks) {
        if (r > combo.rank && byRank.get(r)!.length >= 3) {
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

/**
 * 找人类无法管上的最优出牌
 * 在新回合或需要压制时使用
 */
function findHumanCantBeat(
  myAnalysis: HandAnalysis,
  humanHand: Card[],
  preferBig: boolean
): Card[] | null {
  const { byRank, straights, doubleStraights, pairs, sortedRanks } = myAnalysis

  // 优先出手牌中最长的、人类管不上的顺子
  if (straights.length > 0) {
    for (const s of straights.sort((a, b) => b.length - a.length)) {
      const combo: Card[] = []
      for (const r of s.ranks) combo.push(byRank.get(r)![0])
      // 检查人类能否管上
      const testCombo: Combo = { type: 'straight', cards: combo, rank: s.maxRank as Rank, length: s.length }
      if (!canPlayerBeat(humanHand, testCombo)) return combo
    }
  }

  // 连对
  if (doubleStraights.length > 0) {
    for (const ds of doubleStraights.sort((a, b) => b.pairCount - a.pairCount)) {
      const combo: Card[] = []
      for (const r of ds.ranks) combo.push(byRank.get(r)![0], byRank.get(r)![1])
      const testCombo: Combo = { type: 'double-straight', cards: combo, rank: ds.maxRank as Rank, length: ds.pairCount * 2 }
      if (!canPlayerBeat(humanHand, testCombo)) return combo
    }
  }

  // 对子
  if (pairs.length > 0) {
    const sortedPairs = preferBig ? [...pairs].reverse() : pairs
    for (const r of sortedPairs) {
      const combo = byRank.get(r)!.slice(0, 2)
      const testCombo: Combo = { type: 'pair', cards: combo, rank: r as Rank, length: 1 }
      if (!canPlayerBeat(humanHand, testCombo)) return combo
    }
  }

  // 单张
  const allCards = [...byRank.values()].flat()
  const sorted = preferBig ? sortByRank(allCards) : sortByRankAsc(allCards)
  for (const c of sorted) {
    const testCombo: Combo = { type: 'single', cards: [c], rank: c.rank, length: 1 }
    if (!canPlayerBeat(humanHand, testCombo)) return [c]
  }

  // 人类都能管上 → 出最大的单张（迫使人类出大牌）
  return [sortByRank(allCards)[0]]
}

/**
 * 找最小的能管上 currentPlay 的牌型，且人类无法反管
 */
function findMinimalBlockHumanCantCounter(
  myAnalysis: HandAnalysis,
  humanHand: Card[],
  currentPlay: Combo
): Card[] | null {
  const { byRank, sortedRanks } = myAnalysis
  const allOptions: Card[][] = []

  // 收集所有能管上的选项
  switch (currentPlay.type) {
    case 'single': {
      for (const r of sortedRanks) {
        if (r > currentPlay.rank) allOptions.push([byRank.get(r)![0]])
      }
      break
    }
    case 'pair': {
      for (const r of sortedRanks) {
        if (r > currentPlay.rank && byRank.get(r)!.length >= 2) {
          allOptions.push(byRank.get(r)!.slice(0, 2))
        }
      }
      break
    }
    case 'straight': {
      const len = currentPlay.length
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= currentPlay.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - len + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isConsecutive(neededRanks)) continue
        const cards: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const c = byRank.get(r)
          if (!c || c.length === 0) { ok = false; break }
          cards.push(c[0])
        }
        if (ok) allOptions.push(cards)
      }
      break
    }
    case 'double-straight': {
      const pairCount = currentPlay.length / 2
      for (const tryMax of RANK_SEQ) {
        if (tryMax <= currentPlay.rank) continue
        const maxIdx = RANK_SEQ.indexOf(tryMax)
        const startIdx = maxIdx - pairCount + 1
        if (startIdx < 0) continue
        const neededRanks = RANK_SEQ.slice(startIdx, maxIdx + 1)
        if (!isConsecutive(neededRanks)) continue
        const cards: Card[] = []
        let ok = true
        for (const r of neededRanks) {
          const c = byRank.get(r)
          if (!c || c.length < 2) { ok = false; break }
          cards.push(c[0], c[1])
        }
        if (ok) allOptions.push(cards)
      }
      break
    }
  }

  // 按主牌点数从小到大排序
  allOptions.sort((a, b) => {
    const rankA = Math.max(...a.map(c => c.rank))
    const rankB = Math.max(...b.map(c => c.rank))
    return rankA - rankB
  })

  // 找第一个人类无法反管的
  for (const cards of allOptions) {
    const rank = Math.max(...cards.map(c => c.rank))
    const type = cards.length === 1 ? 'single' : cards.length === 2 && cards[0].rank === cards[1].rank ? 'pair' :
      cards.length >= 3 && cards.every(c => c.rank === cards[0].rank) ? (cards.length === 4 ? 'quadruple' : 'triple') :
      'straight'
    const testCombo: Combo = { type: type as Combo['type'], cards, rank: rank as Rank, length: cards.length }
    if (!canPlayerBeat(humanHand, testCombo)) return cards
  }

  // 人类都能反管 → 加上炸弹
  for (const r of sortedRanks) {
    if (byRank.get(r)!.length >= 4) return byRank.get(r)!.slice(0, 4)
  }
  for (const r of sortedRanks) {
    if (currentPlay.type !== 'triple' && currentPlay.type !== 'quadruple' && byRank.get(r)!.length >= 3) {
      return byRank.get(r)!.slice(0, 3)
    }
  }

  // 实在找不到 → 返回第一个能管上的
  return allOptions.length > 0 ? allOptions[0] : null
}

// ==================== 决策入口 ====================

export interface PlayContext {
  seat: number
  bankerSeat: number
  lastPlay: Combo | null
  lastPlaySeat: number | null
  playerCount: number
  hand: Card[]
  handCounts: number[]       // 各座位剩余牌数
  humanHands?: Card[]        // 明牌模式：人类玩家的手牌
}

export interface PlayDecision {
  cards: Card[] | null  // null 表示过牌
  pass: boolean
}

/**
 * 出牌决策 — 核心入口
 */
export function decidePlay(ctx: PlayContext): PlayDecision {
  const { seat, bankerSeat, lastPlay, lastPlaySeat, hand, handCounts, humanHands } = ctx
  const isBanker = seat === bankerSeat
  const analysis = analyzeHand(hand)

  // ═══ 明牌模式：知道人类手牌 → 最优出牌 ═══
  if (humanHands && humanHands.length > 0) {
    return decidePlayOpenCards(ctx, analysis, humanHands)
  }

  // ═══ 普通模式 ═══

  // ── 新回合（自己出牌）──
  if (!lastPlay) {
    const bankerRemaining = handCounts[bankerSeat] ?? 99
    const combo = pickOpeningCombo(analysis, isBanker, bankerRemaining)
    return { cards: combo, pass: false }
  }

  const lastPlayer = lastPlaySeat!
  const lastIsBanker = lastPlayer === bankerSeat
  const lastIsAlly = !isBanker && !lastIsBanker
  const lastPlayerRemaining = handCounts[lastPlayer] ?? 0

  // ── 🔴 庄家快跑完了 → 不顾一切拦截 ──
  if (lastIsBanker && lastPlayerRemaining <= 2 && lastPlayerRemaining > 0) {
    const beat = findEmergencyBlock(analysis, lastPlay)
    if (beat) return { cards: beat, pass: false }
    return { cards: null, pass: true }
  }

  // ── 🟢 盟友快跑完了 → 打最小的牌送他走 ──
  if (lastIsAlly && lastPlayerRemaining <= 2 && lastPlayerRemaining > 0) {
    const smallest = findSmallestBeatToLetAllyWin(analysis, lastPlay)
    if (smallest) return { cards: smallest, pass: false }
    return { cards: null, pass: true }
  }

  // 1. 盟友出牌 → 让过
  if (lastIsAlly) {
    if (analysis.quality === 'excellent' && analysis.minPlays <= 2) {
      const beat = findSmallestBeat(analysis, lastPlay, true)
      if (beat) return { cards: beat, pass: false }
    }
    return { cards: null, pass: true }
  }

  // 2. 庄家 → 尽量管上
  if (isBanker) {
    const beat = findBestBankerBeat(analysis, lastPlay)
    if (beat) return { cards: beat, pass: false }
    return { cards: null, pass: true }
  }

  // 3. 非庄家拦截庄家
  const goAllOut = Math.random() < 0.9
  if (goAllOut) {
    const beat = findSmallestBeatFull(analysis, lastPlay)
    if (beat) return { cards: beat, pass: false }
  } else {
    const beat = findBeatWithoutBomb(analysis.byRank, analysis.sortedRanks, lastPlay)
    if (beat) return { cards: beat, pass: false }
  }

  return { cards: null, pass: true }
}

/**
 * 明牌模式出牌决策 — 知道人类手牌，确保机器人和盟友赢
 */
function decidePlayOpenCards(
  ctx: PlayContext,
  analysis: HandAnalysis,
  humanHand: Card[]
): PlayDecision {
  const { seat, bankerSeat, lastPlay, lastPlaySeat, handCounts } = ctx
  const isBanker = seat === bankerSeat

  // ── 新回合 → 出人类管不上的牌 ──
  if (!lastPlay) {
    const bankerRemaining = handCounts[bankerSeat] ?? 99
    const combo = findHumanCantBeat(analysis, humanHand, !isBanker && bankerRemaining <= 3)
    if (combo && combo.length > 0) return { cards: combo, pass: false }
    const fallback = pickOpeningCombo(analysis, isBanker, bankerRemaining)
    return { cards: fallback, pass: false }
  }

  const lastPlayer = lastPlaySeat!
  const lastIsBanker = lastPlayer === bankerSeat
  const lastIsAlly = !isBanker && !lastIsBanker
  const lastPlayerRemaining = handCounts[lastPlayer] ?? 0

  // ── 🔴 任何人快出完了 → 拦截（人类要拦，盟友要送）──
  if (lastPlayerRemaining <= 2 && lastPlayerRemaining > 0) {
    if (lastIsAlly) {
      // 盟友快赢了 → 送他
      const smallest = findSmallestBeatToLetAllyWin(analysis, lastPlay)
      if (smallest) return { cards: smallest, pass: false }
      return { cards: null, pass: true }
    }
    // 人类快赢了 → 最优拦截
    const beat = findMinimalBlockHumanCantCounter(analysis, humanHand, lastPlay)
    if (beat) return { cards: beat, pass: false }
    const emergency = findEmergencyBlock(analysis, lastPlay)
    if (emergency) return { cards: emergency, pass: false }
    return { cards: null, pass: true }
  }

  // 1. 盟友出牌 → 让过
  if (lastIsAlly) {
    if (analysis.quality === 'excellent' && analysis.minPlays <= 2) {
      const beat = findSmallestBeat(analysis, lastPlay, true)
      if (beat) return { cards: beat, pass: false }
    }
    return { cards: null, pass: true }
  }

  // 2. 人类出牌 → 找最优拦截（人类无法反管的最小牌型）
  const beat = findMinimalBlockHumanCantCounter(analysis, humanHand, lastPlay)
  if (beat) return { cards: beat, pass: false }

  // 找不到完美拦截 → 用炸弹
  const bomb = findBombBeat(analysis.byRank, analysis.sortedRanks, analysis.bombRanks, lastPlay)
  if (bomb) return { cards: bomb, pass: false }

  return { cards: null, pass: true }
}

/**
 * 紧急拦截：庄家只剩1-2张牌时，不惜一切代价拦住
 * 有炸弹用炸弹，没炸弹用最大能管上的牌型
 */
function findEmergencyBlock(analysis: HandAnalysis, lastPlay: Combo): Card[] | null {
  const { byRank, sortedRanks, bombRanks } = analysis

  // 1. 先尝试非炸弹拦截（保留炸弹用于下一手可能的拦截）
  const normal = findBeatWithoutBomb(byRank, sortedRanks, lastPlay)
  if (normal) return normal

  // 2. 用炸弹拦截
  return findBombBeat(byRank, sortedRanks, bombRanks, lastPlay)
}

/**
 * 盟友快赢了 → 打出最小的能管上的牌，让盟友能够接过去
 * 如果管不上就过牌（盟友自己出完即可）
 */
function findSmallestBeatToLetAllyWin(analysis: HandAnalysis, lastPlay: Combo): Card[] | null {
  const { byRank, sortedRanks, bombRanks } = analysis

  switch (lastPlay.type) {
    case 'single': {
      // 找最小的能管上的单张
      for (const r of sortedRanks) {
        if (r > lastPlay.rank && !bombRanks.includes(r)) {
          return [byRank.get(r)![0]]
        }
      }
      return null
    }
    case 'pair': {
      for (const r of sortedRanks) {
        if (r > lastPlay.rank && byRank.get(r)!.length >= 2 && !bombRanks.includes(r)) {
          return byRank.get(r)!.slice(0, 2)
        }
      }
      return null
    }
    default:
      // 顺子/连对等情况：直接pass，让盟友自己赢
      return null
  }
}

/**
 * 庄家找最优防守牌型：既要管上，又要不浪费牌力
 */
function findBestBankerBeat(analysis: HandAnalysis, lastPlay: Combo): Card[] | null {
  // 庄家优先级：常规牌型 > 拆炸牌型 > 炸弹
  const { byRank, sortedRanks, bombRanks, minPlays } = analysis

  // 1. 先用非炸弹找
  const normal = findBeatWithoutBomb(byRank, sortedRanks, lastPlay)
  if (normal) return normal

  // 2. 如果用炸弹后剩余手牌仍能出完（minPlays合理），用炸弹
  // 计算用炸弹后的剩余手牌
  const remainingCards = [...byRank.values()].flat().length
  if (bombRanks.length > 0 && remainingCards <= 6) {
    // 快出完了，可以用炸弹
    return findBombBeat(byRank, sortedRanks, bombRanks, lastPlay)
  }

  // 3. 手牌还多，留着炸弹
  return null
}

/**
 * 全力拦截：用上所有可用牌型（含炸弹）
 */
function findSmallestBeatFull(analysis: HandAnalysis, lastPlay: Combo): Card[] | null {
  const { byRank, sortedRanks, bombRanks } = analysis

  const normal = findBeatWithoutBomb(byRank, sortedRanks, lastPlay)
  if (normal) return normal

  return findBombBeat(byRank, sortedRanks, bombRanks, lastPlay)
}

// ==================== 要牌决策 ====================

export interface BidContext {
  seat: number
  startingSeat: number
  isFirstGame: boolean
  hand: Card[]
  hasHeart4: boolean
}

export interface BidDecision {
  shouldRequest: boolean
  card?: Card        // 想要的牌
  giveCard?: Card    // 用来交换的牌
}

/**
 * 要牌阶段决策
 * - 红心4 100% 要牌
 * - 非起始人：有概率 pass（除非牌太好）
 * - 要牌时给出最没用的小牌（非K）
 */
export function decideRequestBid(ctx: BidContext): BidDecision {
  const { seat, startingSeat, isFirstGame, hand, hasHeart4 } = ctx
  const isStarting = seat === startingSeat

  // 红心4在手上，100% 要牌
  if (isFirstGame && hasHeart4) {
    const card = pickBestRequestCard(hand)
    if (card) {
      return { shouldRequest: true, card, giveCard: pickGiveCard(hand) }
    }
    // 极端情况：实在找不到能要的牌（不应该发生）
    return { shouldRequest: false }
  }

  // 起始人必须参与
  if (isStarting) {
    const card = pickBestRequestCard(hand)
    if (card) {
      return { shouldRequest: true, card, giveCard: pickGiveCard(hand) }
    }
    return { shouldRequest: false }
  }

  // 非起始人：手牌好则积极要牌，否则概率pass
  const analysis = analyzeHand(hand)
  if (analysis.quality === 'excellent' || analysis.quality === 'good') {
    const card = pickBestRequestCard(hand)
    if (card && Math.random() < 0.7) {
      return { shouldRequest: true, card, giveCard: pickGiveCard(hand) }
    }
  } else if (Math.random() < 0.4) {
    const card = pickBestRequestCard(hand)
    if (card) {
      return { shouldRequest: true, card, giveCard: pickGiveCard(hand) }
    }
  }

  return { shouldRequest: false }
}

/**
 * 从非手牌、非K的牌中选最优的要牌目标
 * 优先选能补全顺子的牌，其次选高点数
 */
function pickBestRequestCard(hand: Card[]): Card | null {
  const byRank = groupByRank(hand)
  const ranksInHand = new Set(byRank.keys())

  // 找缺少一张就能形成顺子的点数
  const desiredRanks = findMissingStraightRanks(ranksInHand)

  // 优先度：补全顺子的点数 > Q > J > 10 > ... > 4
  const priorityRanks = [...desiredRanks, 12, 11, 10, 9, 7, 6, 5, 4]

  for (const rank of priorityRanks) {
    for (const suit of SUITS) {
      if (!hand.some(c => c.suit === suit && c.rank === rank)) {
        return { suit, rank } as Card
      }
    }
  }
  return null
}

/** 找出缺少一张就能形成顺子的点数 */
function findMissingStraightRanks(ranksInHand: Set<number>): number[] {
  const desired: number[] = []
  const segments = [[4, 5, 6, 7], [9, 10, 11, 12, 13]]

  for (const seg of segments) {
    for (let startIdx = 0; startIdx < seg.length; startIdx++) {
      for (let endIdx = startIdx + 2; endIdx < seg.length; endIdx++) {
        const ranks = seg.slice(startIdx, endIdx + 1)
        const have = ranks.filter(r => ranksInHand.has(r))
        const missing = ranks.filter(r => !ranksInHand.has(r))
        // 只差1张就能形成顺子 → 优先要
        if (missing.length === 1 && missing[0] !== 13) {
          desired.push(missing[0])
        }
      }
    }
  }
  return [...new Set(desired)]
}

/**
 * 选择要给出的牌：
 * - 不能是K
 * - 优先给出手牌中「最没用」的牌（孤立单张小牌）
 */
export function pickGiveCard(hand: Card[]): Card {
  const byRank = groupByRank(hand)

  // 找孤立单张（只有1张的点数）中最小的
  const singles = [...byRank.entries()]
    .filter(([rank, cards]) => cards.length === 1 && rank !== 13)
    .map(([, cards]) => cards[0])
    .sort((a, b) => a.rank - b.rank)

  if (singles.length > 0) return singles[0]

  // 没有孤立单张 → 找最小的非K牌
  const nonK = hand.filter(c => c.rank !== 13).sort((a, b) => a.rank - b.rank)
  if (nonK.length > 0) return nonK[0]

  // 全是K（极端情况）
  return hand[0]
}
