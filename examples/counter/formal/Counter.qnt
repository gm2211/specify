// A counter that counts up to a cap and stops there.
// `Counter` is the intended design. `CounterBefore` keeps an old bug, an undo
// that can run at any time, so the checks show the properties catch it.
module Counter {
  pure val CAP = 3
  var count: int

  action init = count' = 0
  action increment = all { count < CAP, count' = count + 1 }
  action stay = all { count == CAP, count' = count }
  action step = any { increment, stay }

  // Safety: the count never goes below zero.
  val nonNegative = count >= 0
  // Liveness: if steps keep being taken, the count reaches the cap.
  temporal reachesCap = weakFair(step, count) implies eventually(count == CAP)
}

module CounterBefore {
  pure val CAP = 3
  var count: int

  action init = count' = 0
  action increment = all { count < CAP, count' = count + 1 }
  action undo = all { count > -1, count' = count - 1 }
  action step = any { increment, undo }

  val nonNegative = count >= 0
  temporal reachesCap = weakFair(step, count) implies eventually(count == CAP)
}
