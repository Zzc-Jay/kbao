// 快速验证 — 核心逻辑完整性检查
import { createDeck, shuffle, deal, findStartingPlayer } from './deck'
import { identifyCombo, canBeat } from './combo'
import { canRequestCard, resolveBidding } from './bid'
import { settle, settleDole } from './score'
import { Bid } from './types'

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

console.log('=== 牌组测试 ===')
const deck4 = createDeck(4)
assert(deck4.length === 36, '4人局 36 张牌')
const deck5 = createDeck(5)
assert(deck5.length === 35, '5人局 35 张牌（去一张K）')
const deck6 = createDeck(6)
assert(deck6.length === 36, '6人局 36 张牌')

const shuffled = shuffle(deck4)
assert(shuffled.length === 36, '洗牌后数量不变')
assert(shuffled.some((c, i) => c.rank !== deck4[i]?.rank || c.suit !== deck4[i]?.suit),
  '洗牌后顺序变化')

const hands = deal(shuffled, 4)
assert(hands.length === 4, '4人每人有牌')
assert(hands.every(h => h.length === 9), '每人 9 张')

// 模拟摸到红心4
const heart4Hand = hands.findIndex(h => h.some(c => c.suit === 'heart' && c.rank === 4))
// 用 findStartingPlayer 验证
const startSeat = findStartingPlayer(hands)
assert(startSeat === heart4Hand, `红心4在座 ${startSeat}`)

console.log('\n=== 牌型识别测试 ===')
const single = identifyCombo([{ suit: 'spade', rank: 13 }])
assert(single?.type === 'single', '单张识别')
assert(single?.rank === 13, '单张点数正确')

const pair = identifyCombo([
  { suit: 'spade', rank: 10 },
  { suit: 'heart', rank: 10 },
])
assert(pair?.type === 'pair', '对子识别')

const triple = identifyCombo([
  { suit: 'spade', rank: 7 },
  { suit: 'heart', rank: 7 },
  { suit: 'club', rank: 7 },
])
assert(triple?.type === 'triple', '三张（炸弹）识别')

const quad = identifyCombo([
  { suit: 'spade', rank: 5 },
  { suit: 'heart', rank: 5 },
  { suit: 'club', rank: 5 },
  { suit: 'diamond', rank: 5 },
])
assert(quad?.type === 'quadruple', '四张（炸弹）识别')

const straight = identifyCombo([
  { suit: 'spade', rank: 11 },
  { suit: 'heart', rank: 10 },
  { suit: 'club', rank: 9 },
])
assert(straight?.type === 'straight' && straight?.length === 3,
  '顺子 9-10-J 识别')

const straightLong = identifyCombo([
  { suit: 'spade', rank: 13 },
  { suit: 'heart', rank: 12 },
  { suit: 'club', rank: 11 },
  { suit: 'diamond', rank: 10 },
  { suit: 'spade', rank: 9 },
])
assert(straightLong?.type === 'straight' && straightLong?.length === 5,
  '顺子 9-10-J-Q-K 识别')

const invalidGap = identifyCombo([
  { suit: 'spade', rank: 9 },
  { suit: 'heart', rank: 7 },
  { suit: 'club', rank: 6 },
])
assert(invalidGap === null, '6-7-9 不连续（拒绝）')

const doubleStraight = identifyCombo([
  { suit: 'spade', rank: 6 },
  { suit: 'heart', rank: 6 },
  { suit: 'club', rank: 5 },
  { suit: 'diamond', rank: 5 },
])
assert(doubleStraight?.type === 'double-straight', '连对 5-5-6-6 识别')

const invalidPair = identifyCombo([
  { suit: 'spade', rank: 9 },
  { suit: 'heart', rank: 5 },
])
assert(invalidPair === null, '不同点数的两张不是对子（拒绝）')

console.log('\n=== 牌型比较测试 ===')
const kSingle = identifyCombo([{ suit: 'spade', rank: 13 }])!
const qSingle = identifyCombo([{ suit: 'heart', rank: 12 }])!
assert(canBeat(kSingle, qSingle), 'K 压 Q')
assert(!canBeat(qSingle, kSingle), 'Q 不能压 K')

const tripleBomb = identifyCombo([
  { suit: 'spade', rank: 4 }, { suit: 'heart', rank: 4 }, { suit: 'club', rank: 4 }
])!
assert(canBeat(tripleBomb, kSingle), '三张炸弹可压单张')
assert(!canBeat(kSingle, tripleBomb), '单张不能压三张炸弹')

const quadBomb = identifyCombo([
  { suit: 'spade', rank: 4 }, { suit: 'heart', rank: 4 },
  { suit: 'club', rank: 4 }, { suit: 'diamond', rank: 4 }
])!
assert(canBeat(quadBomb, tripleBomb), '四张炸弹可压三张炸弹')
assert(canBeat(quadBomb, kSingle), '四张炸弹可压单张')

// 新回合任何牌型均可出
assert(canBeat(kSingle, null), '新回合任意出牌')

console.log('\n=== 包牌逻辑测试 ===')
// 第一轮有人冲
const chargeBids: Bid[] = [
  { type: 'pass', seat: 0 },
  { type: 'pass', seat: 1 },
  { type: 'charge', seat: 2 },
]
const r1 = resolveBidding(chargeBids, [], 0)
assert(r1.phase === 'playing' && r1.bankerSeat === 2 && r1.multiplier === 5,
  '冲→庄家2号座，5倍')

// 第二轮多人要牌
const requestBids: Bid[] = [
  { type: 'request', seat: 0, card: { suit: 'spade', rank: 12 } },
  { type: 'request', seat: 1, card: { suit: 'heart', rank: 11 } },
  { type: 'pass', seat: 2 },
  { type: 'request', seat: 3, card: { suit: 'club', rank: 10 } },
]
const r2 = resolveBidding([], requestBids, 0)
assert(r2.phase === 'playing' && r2.bankerSeat === 3 && r2.multiplier === 3,
  '3人要牌→庄家3号座，3倍')

// 只有起始人要→低保
const doleBids: Bid[] = [
  { type: 'request', seat: 0, card: { suit: 'spade', rank: 12 } },
  { type: 'pass', seat: 1 },
  { type: 'pass', seat: 2 },
  { type: 'pass', seat: 3 },
]
const r3 = resolveBidding([], doleBids, 0)
assert(r3.phase === 'dole' && r3.bankerSeat === 0,
  '只有起始人要→低保')

// 要牌不能要K
const cantK = canRequestCard(
  { suit: 'spade', rank: 13 },
  [{ suit: 'heart', rank: 5 }],
  []
)
assert(!cantK.ok, '要K被拒绝')

// 要牌可以要Q
const canQ = canRequestCard(
  { suit: 'spade', rank: 12 },
  [{ suit: 'heart', rank: 5 }],
  []
)
assert(canQ.ok, '要Q允许')

  // 不能拿K去要牌
  const cantGiveK = canRequestCard(
    { suit: 'spade', rank: 10 },
    [{ suit: 'heart', rank: 13 }, { suit: 'heart', rank: 5 }],
    [],
    { suit: 'heart', rank: 13 }
  )
  assert(!cantGiveK.ok, '拿K去要牌被拒绝')

console.log('\n=== 结算测试 ===')
const payoutWin = settle(0, true, 5, 4)
assert(payoutWin[0] === 15, '庄家赢5倍→收15（3对手×5）')
assert(payoutWin[1] === -5, '对手1付5')
assert(payoutWin[2] === -5, '对手2付5')
assert(payoutWin[3] === -5, '对手3付5')

const payoutLose = settle(0, false, 3, 4)
assert(payoutLose[0] === -9, '庄家输3倍→付9（3对手×3）')
assert(payoutLose[1] === 3, '对手1赢3')
assert(payoutLose[2] === 3, '对手2赢3')
assert(payoutLose[3] === 3, '对手3赢3')

const dolePayout = settleDole(2, 4)
assert(dolePayout[2] === 3, '低保者从3人各收1，共3')
assert(dolePayout[0] === -1, '非低保者付1')

console.log('\n🎉 全部验证通过！')
