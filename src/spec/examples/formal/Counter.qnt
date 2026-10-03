module Counter {
  var count: int

  action init = count' = 0
  action step = count' = count + 1

  val nonNegative = count >= 0
}
