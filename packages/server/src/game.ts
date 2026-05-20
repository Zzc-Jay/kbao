import {
  Card, GamePhase, Bid, Combo, Player,
  createDeck, shuffle, deal, findStartingPlayer,
  identifyCombo, canBeat, resolveBidding, settle, settleDole,
  canRequestCard,
} from 'kbao-core'

export interface GameEventBus {
  emitDeal(roomCode: string, hands: Card[][]): void
  emitPhase(roomCode: string, phase: GamePhase, currentTurn: number): void
  emitBidAsk(roomCode: string, seat: number, phase: 'charge' | 'request'): void
  emitBidResult(roomCode: string, bids: Bid[], bankerSeat: number, multiplier: number): void
  emitCardSwapped(roomCode: string, requesterSeat: number, holderSeat: number,
    wantedCard: Card, requesterNewHand: Card[], holderNewHand: Card[]): void
  emitPlayAsk(roomCode: string, seat: number, comboType: string | null, lastPlay: Combo | null): void
  emitPlayReject(roomCode: string, seat: number, reason: string): void
  emitPlayResult(roomCode: string, seat: number, combo: Combo | null, isPass: boolean): void
  emitGameOver(roomCode: string, bankerWin: boolean, payouts: number[], multiplier: number, bidType: string, hands: Card[][]): void
  emitDole(roomCode: string, doleSeat: number, payouts: number[], multiplier: number): void
  emitNextRound(roomCode: string): void
}

export class Game {
  private roomCode: string
  private playerCount: number
  private hands: Card[][]          // 每人手牌（仅服务器持有）
  private phase: GamePhase
  private currentTurn: number
  private bankerSeat: number
  private multiplier: number
  private startingSeat: number     // 本局起始人
  private nextStartingSeat: number // 下一局起始人
  private lastPlay: Combo | null
  private lastPlaySeat: number | null
  private passSet: Set<number>     // 本轮已过牌玩家
  private chargeBids: Bid[]
  private requestBids: Bid[]
  private roundHistory: any[]
  private readyPlayers: Set<number>
  private eventBus: GameEventBus
  private firstGame: boolean       // 是否为本房间第一局
  private debug: boolean            // 调试模式
  private openCards: boolean        // 明牌模式：机器人知道玩家手牌

  constructor(roomCode: string, playerCount: number, eventBus: GameEventBus, debug = false, openCards = false) {
    this.debug = debug
    this.openCards = openCards
    this.roomCode = roomCode
    this.playerCount = playerCount
    this.eventBus = eventBus
    this.hands = []
    this.phase = 'bidding-charge'
    this.currentTurn = -1
    this.bankerSeat = -1
    this.multiplier = 1
    this.startingSeat = 0
    this.nextStartingSeat = 0
    this.lastPlay = null
    this.lastPlaySeat = null
    this.passSet = new Set()
    this.chargeBids = []
    this.requestBids = []
    this.roundHistory = []
    this.readyPlayers = new Set()
    this.firstGame = true
  }

  /** 开始游戏（发牌+进入包牌阶段） */
  start(): void {
    const deck = shuffle(createDeck(this.playerCount))
    this.hands = deal(deck, this.playerCount)

    // 确定起始人
    if (this.firstGame) {
      this.startingSeat = findStartingPlayer(this.hands)
      if (this.startingSeat < 0) this.startingSeat = 0
      this.firstGame = false
    } else {
      this.startingSeat = this.nextStartingSeat
    }

    this.currentTurn = this.startingSeat
    this.readyPlayers.clear()

    // 发牌（每人只看到自己的）
    this.eventBus.emitDeal(this.roomCode, this.hands)

    // 进入第一轮包牌：冲
    this.phase = 'bidding-charge'
    this.chargeBids = []
    this.requestBids = []
    this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
    this.eventBus.emitBidAsk(this.roomCode, this.currentTurn, 'charge')
  }

  /** 处理包牌提交 */
  submitBid(seat: number, bid: Bid): { ok: boolean; reason?: string } {
    if (seat !== this.currentTurn) return { ok: false, reason: '还没轮到你' }

    if (this.phase === 'bidding-charge') {
      if (bid.type !== 'charge' && bid.type !== 'pass') {
        return { ok: false, reason: '冲阶段只能选择冲或不冲' }
      }
      this.chargeBids.push(bid)

      if (bid.type === 'charge') {
        // 有人冲，立即成为庄家
        this.bankerSeat = seat
        this.multiplier = 5
        this.eventBus.emitBidResult(this.roomCode, this.chargeBids, this.bankerSeat, this.multiplier)
        this.startPlaying()
        return { ok: true }
      }

      // 过：轮到下一人
      this.currentTurn = (this.currentTurn - 1 + this.playerCount) % this.playerCount

      // 所有人都过了？
      if (this.currentTurn === this.startingSeat) {
        // 全过，进入要牌阶段
        this.phase = 'bidding-request'
        this.requestBids = []
        this.currentTurn = this.startingSeat
        this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
        this.eventBus.emitBidAsk(this.roomCode, this.currentTurn, 'request')
        return { ok: true }
      }

      this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
      this.eventBus.emitBidAsk(this.roomCode, this.currentTurn, 'charge')
      return { ok: true }
    }

    if (this.phase === 'bidding-request') {
      if (this.currentTurn === this.startingSeat && bid.type === 'pass') {
        return { ok: false, reason: '起始人必须参与要牌' }
      }
      if (bid.type === 'request') {
        // 校验要牌合法性
        const check = canRequestCard(bid.card, this.hands[seat], this.requestBids, (bid as any).giveCard)
        if (!check.ok) return check

        // 找到持有者并交换
        const holderSeat = this.swapCard(bid.card, seat, (bid as any).giveCard)
        if (holderSeat >= 0) {
          // 通知双方手牌变更（公开：谁要了谁的什么牌；私密：各自新手牌）
          this.eventBus.emitCardSwapped(
            this.roomCode, seat, holderSeat, bid.card,
            [...this.hands[seat]], [...this.hands[holderSeat]]
          )
        }

        this.requestBids.push(bid)
      } else if (bid.type === 'pass') {
        this.requestBids.push(bid)
      }

      // 轮到下一人
      this.currentTurn = (this.currentTurn - 1 + this.playerCount) % this.playerCount

      // 所有人都轮过了？
      if (this.currentTurn === this.startingSeat) {
        const result = resolveBidding(this.chargeBids, this.requestBids, this.startingSeat)

        if (result.phase === 'dole') {
          // 低保结算
          const dolePayouts = settleDole(result.bankerSeat, this.playerCount)
          this.roundHistory.push({
            bankerSeat: result.bankerSeat,
            bankerWin: true,
            multiplier: 1,
            payouts: dolePayouts,
            bidType: 'dole',
          })
          this.eventBus.emitDole(this.roomCode, result.bankerSeat, dolePayouts, 1)
          // 低保后自动重开新局，起始人不变
          this.nextStartingSeat = this.startingSeat
          this.scheduleNextRound()
          return { ok: true }
        }

        if (result.phase === 'redeal') {
          // 不应发生（起始人必须参与），兜底
          return { ok: false, reason: '无效的包牌状态' }
        }

        this.bankerSeat = result.bankerSeat
        this.multiplier = result.multiplier
        this.eventBus.emitBidResult(this.roomCode, this.requestBids, this.bankerSeat, this.multiplier)
        this.startPlaying()
        return { ok: true }
      }

      this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
      this.eventBus.emitBidAsk(this.roomCode, this.currentTurn, 'request')
      return { ok: true }
    }

    return { ok: false, reason: '当前不是包牌阶段' }
  }

  /** 提交出牌 */
  submitPlay(seat: number, cards: Card[]): { ok: boolean; reason?: string } {
    if (this.phase !== 'playing') return { ok: false, reason: '当前不是出牌阶段' }
    if (seat !== this.currentTurn) return { ok: false, reason: '还没轮到你' }

    const combo = identifyCombo(cards)
    if (!combo) return { ok: false, reason: '非法牌型' }

    // 检查手牌中是否真的有这些牌
    if (!this.hasCards(seat, cards)) return { ok: false, reason: '手牌中没有这些牌' }

    if (!canBeat(combo, this.lastPlay)) {
      return { ok: false, reason: '管不上，需要更大的牌型' }
    }

    // 从手牌移除
    this.removeCards(seat, cards)

    this.lastPlay = combo
    this.lastPlaySeat = seat
    this.passSet.clear()
    this.eventBus.emitPlayResult(this.roomCode, seat, combo, false)

    // 检查手牌是否清空
    if (this.hands[seat].length === 0) {
      this.endGame(seat)
      return { ok: true }
    }

    // 下一个出牌者
    this.currentTurn = (this.currentTurn - 1 + this.playerCount) % this.playerCount
    this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
    this.eventBus.emitPlayAsk(this.roomCode, this.currentTurn,
      combo.type, combo)

    return { ok: true }
  }

  /** 过牌 */
  pass(seat: number): { ok: boolean; reason?: string } {
    if (this.phase !== 'playing') return { ok: false, reason: '当前不是出牌阶段' }
    if (seat !== this.currentTurn) return { ok: false, reason: '还没轮到你' }

    // 新回合不能过（必须出牌）
    if (this.lastPlay === null) return { ok: false, reason: '新回合必须出牌' }

    this.passSet.add(seat)
    this.eventBus.emitPlayResult(this.roomCode, seat, null, true)

    // 除最后出牌者外所有人都过了？
    const totalOthers = this.playerCount - 1
    if (this.passSet.size >= totalOthers) {
      // 回合结束，最后出牌者获出牌权
      this.currentTurn = this.lastPlaySeat!
      this.lastPlay = null
      this.lastPlaySeat = null
      this.passSet.clear()
      this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
      this.eventBus.emitPlayAsk(this.roomCode, this.currentTurn, null, null)
      return { ok: true }
    }

    this.currentTurn = (this.currentTurn - 1 + this.playerCount) % this.playerCount
    // 跳过已过牌的玩家
    while (this.passSet.has(this.currentTurn)) {
      this.currentTurn = (this.currentTurn - 1 + this.playerCount) % this.playerCount
    }
    this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
    this.eventBus.emitPlayAsk(this.roomCode, this.currentTurn,
      this.lastPlay?.type ?? null, this.lastPlay)
    return { ok: true }
  }

  getPhase(): GamePhase { return this.phase }
  getCurrentTurn(): number { return this.currentTurn }
  getBankerSeat(): number { return this.bankerSeat }
  getHands(): Card[][] { return this.hands }
  getMultiplier(): number { return this.multiplier }
  getStartingSeat(): number { return this.startingSeat }
  getPlayerCount(): number { return this.playerCount }
  getRoundHistory(): any[] { return this.roundHistory }
  getLastPlay(): Combo | null { return this.lastPlay }
  getLastPlaySeat(): number | null { return this.lastPlaySeat }
  isFirstGame(): boolean { return this.firstGame }
  isOpenCards(): boolean { return this.openCards }
  hasHeart4(seat: number): boolean {
    return this.hands[seat]?.some(c => c.suit === 'heart' && c.rank === 4) ?? false
  }

  markReady(seat: number): void { this.readyPlayers.add(seat) }
  allReady(): boolean { return this.readyPlayers.size >= this.playerCount }

  // ─── 内部方法 ───

  private startPlaying(): void {
    this.phase = 'playing'
    this.currentTurn = this.bankerSeat
    this.lastPlay = null
    this.lastPlaySeat = null
    this.passSet.clear()
    this.eventBus.emitPhase(this.roomCode, this.phase, this.currentTurn)
    this.eventBus.emitPlayAsk(this.roomCode, this.currentTurn, null, null)
  }

  private endGame(winnerSeat: number): void {
    this.phase = 'settlement'
    const bankerWin = winnerSeat === this.bankerSeat
    const payouts = settle(this.bankerSeat, bankerWin, this.multiplier, this.playerCount)
    const bidType = this.chargeBids.some(b => b.type === 'charge') ? 'charge' : 'request'

    this.roundHistory.push({
      bankerSeat: this.bankerSeat,
      bankerWin,
      multiplier: this.multiplier,
      payouts,
      bidType,
    })

    this.nextStartingSeat = this.bankerSeat
    this.eventBus.emitGameOver(this.roomCode, bankerWin, payouts, this.multiplier, bidType, this.hands)
  }

  nextRound(): void {
    this.eventBus.emitNextRound(this.roomCode)
    this.start()
  }

  private scheduleNextRound(): void {
    setTimeout(() => {
      this.eventBus.emitNextRound(this.roomCode)
      this.start()
    }, 2500)
  }

  /** 交换牌：要牌者获得想要的牌，持有者获得回牌。返回持有者座位号，-1 表示未找到 */
  private swapCard(wanted: Card, requesterSeat: number, giveCard?: Card): number {
    for (let s = 0; s < this.hands.length; s++) {
      if (s === requesterSeat) continue
      const idx = this.hands[s].findIndex(
        c => c.suit === wanted.suit && c.rank === wanted.rank
      )
      if (idx >= 0) {
        let giveBack: Card
        if (giveCard) {
          const giveIdx = this.hands[requesterSeat].findIndex(
            c => c.suit === giveCard.suit && c.rank === giveCard.rank
          )
          if (giveIdx >= 0) {
            giveBack = this.hands[requesterSeat].splice(giveIdx, 1)[0]
          } else {
            giveBack = this.hands[requesterSeat].shift()!
          }
        } else {
          giveBack = this.hands[requesterSeat].shift()!
        }
        this.hands[requesterSeat].push(this.hands[s][idx])
        this.hands[s][idx] = giveBack
        this.hands[s].sort((a, b) => b.rank - a.rank)
        this.hands[requesterSeat].sort((a, b) => b.rank - a.rank)
        return s
      }
    }
    return -1
  }

  private hasCards(seat: number, cards: Card[]): boolean {
    const hand = this.hands[seat]
    for (const c of cards) {
      const idx = hand.findIndex(h => h.suit === c.suit && h.rank === c.rank)
      if (idx < 0) return false
    }
    return true
  }

  private removeCards(seat: number, cards: Card[]): void {
    const hand = this.hands[seat]
    for (const c of cards) {
      const idx = hand.findIndex(h => h.suit === c.suit && h.rank === c.rank)
      if (idx >= 0) hand.splice(idx, 1)
    }
  }
}
