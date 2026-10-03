import Lean

namespace Counter

theorem incrementPreservesNonnegative (count : Int) (h : 0 <= count) : 0 <= count + 1 := by
  omega

end Counter
