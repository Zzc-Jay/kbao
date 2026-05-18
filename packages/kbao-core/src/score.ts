/**
 * 结算：庄家赢则从每个对手赢 multiplier × base
 *       庄家输则付给每个对手 multiplier × base
 * @returns 每人收支数组（正=赢，负=输），下标为座位号
 */
export function settle(
  bankerSeat: number,
  bankerWin: boolean,
  multiplier: number,
  playerCount: number,
  base: number = 1
): number[] {
  const payouts = new Array(playerCount).fill(0)

  for (let seat = 0; seat < playerCount; seat++) {
    if (seat === bankerSeat) continue
    if (bankerWin) {
      // 庄家赢：从每个对手收
      payouts[seat] = -multiplier * base
      payouts[bankerSeat] += multiplier * base
    } else {
      // 庄家输：付给每个对手
      payouts[seat] = multiplier * base
      payouts[bankerSeat] -= multiplier * base
    }
  }

  return payouts
}

/**
 * 低保结算：每人给低保者 1 分
 */
export function settleDole(
  doleSeat: number,
  playerCount: number
): number[] {
  const payouts = new Array(playerCount).fill(0)
  for (let seat = 0; seat < playerCount; seat++) {
    if (seat === doleSeat) {
      payouts[seat] = playerCount - 1
    } else {
      payouts[seat] = -1
    }
  }
  return payouts
}
