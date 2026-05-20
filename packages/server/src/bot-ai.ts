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
 * 策略：
 * - 优先出最长顺子（每点数用1张，不破坏炸弹）
 * - 其次出连对（但评估是否值得拆炸弹）
 * - 再其次出对子
 * - 保留炸弹（炸弹留着用于夺回出牌权）
 */
function pickOpeningCombo(analysis: HandAnalysis): Card[] {
  const { byRank, straights, doubleStraights, pairs, bombRanks } = analysis

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
    // 按连对长度降序排列
    const sorted = [...doubleStraights].sort((a, b) => b.pairCount - a.pairCount)
    for (const ds of sorted) {
      // 计算拆弹代价：此连对会消耗多少个炸弹点数的2张以上
      const bombBreakCount = ds.ranks.filter(r => bombRanks.includes(r)).length
      const pairCount = ds.pairCount

      // 如果连对涉及的炸弹点数 >= 2，且连对不够长 → 不拆
      if (bombBreakCount >= 1 && pairCount < 3) continue

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

  // 4. 出最小的单张（避开炸弹点数中唯一的牌）
  const allCards = [...byRank.values()].flat()
  const nonBombCards = allCards.filter(c => !bombRanks.includes(c.rank))
  const pick = nonBombCards.length > 0 ? nonBombCards : allCards
  return [sortByRankAsc(pick)[0]]
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

// ==================== 决策入口 ====================

export interface PlayContext {
  seat: number
  bankerSeat: number
  lastPlay: Combo | null
  lastPlaySeat: number | null
  playerCount: number
  hand: Card[]
}

export interface PlayDecision {
  cards: Card[] | null  // null 表示过牌
  pass: boolean
}

/**
 * 出牌决策
 */
export function decidePlay(ctx: PlayContext): PlayDecision {
  const { seat, bankerSeat, lastPlay, lastPlaySeat, hand } = ctx
  const isBanker = seat === bankerSeat
  const analysis = analyzeHand(hand)

  // ── 新回合（自己出牌）──
  if (!lastPlay) {
    const combo = pickOpeningCombo(analysis)
    return { cards: combo, pass: false }
  }

  // ── 需要应对桌上的牌 ──
  const lastPlayer = lastPlaySeat!
  const lastIsBanker = lastPlayer === bankerSeat
  const lastIsAlly = !isBanker && !lastIsBanker
  const isAttackingMe = isBanker ? true : lastIsBanker

  // 1. 如果是我方盟友出的牌 → 通常让过
  if (lastIsAlly) {
    // 除非自己牌极好，能一鼓作气出完
    if (analysis.quality === 'excellent' && analysis.minPlays <= 2) {
      const beat = findSmallestBeat(analysis, lastPlay, true)
      if (beat) return { cards: beat, pass: false }
    }
    return { cards: null, pass: true }
  }

  // 2. 如果我是庄家 → 尽量要管上，保留出牌权
  if (isBanker) {
    // 检查手牌：如果出了这一手后 minPlays 不劣化太多
    const beat = findBestBankerBeat(analysis, lastPlay)
    if (beat) return { cards: beat, pass: false }
    return { cards: null, pass: true }
  }

  // 3. 我是非庄家，要拦截庄家
  // 90% 概率全力拦截，10% 概率留炸弹
  const goAllOut = Math.random() < 0.9

  if (goAllOut) {
    // 尝试找到能管上的最小牌型（包含炸弹）
    const beat = findSmallestBeatFull(analysis, lastPlay)
    if (beat) return { cards: beat, pass: false }
  } else {
    // 10% 保留炸弹：只用非炸弹牌型
    const beat = findBeatWithoutBomb(analysis.byRank, analysis.sortedRanks, lastPlay)
    if (beat) return { cards: beat, pass: false }
  }

  return { cards: null, pass: true }
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
