// How one check and a whole run are judged.
// Assumptions: a run holds at most three checks; each has an expectation and an observed status.
// `oks` collects one flag per check, `valid` is the run's verdict.
module Verdict {
  pure val EXPECTS = Set("holds", "fails")
  pure val STATUSES = Set("holds", "fails", "error", "timeout", "unavailable")
  var lastExpect: str
  var lastStatus: str
  var lastOk: bool
  var oks: List[bool]
  var valid: bool

  pure def asExpected(status: str, expected: str): bool = status == expected
  pure def validRun(flags: List[bool]): bool =
    flags.length() > 0 and flags.foldl(true, (sofar, flag) => sofar and flag)

  action init = all {
    lastExpect' = "holds",
    lastStatus' = "error",
    lastOk' = false,
    oks' = [],
    valid' = validRun([]),
  }
  action check = {
    nondet expected = EXPECTS.oneOf()
    nondet status = STATUSES.oneOf()
    val ok = asExpected(status, expected)
    all {
      oks.length() < 3,
      lastExpect' = expected,
      lastStatus' = status,
      lastOk' = ok,
      oks' = oks.append(ok),
      valid' = validRun(oks.append(ok)),
    }
  }
  action done = all {
    oks.length() == 3,
    lastExpect' = lastExpect,
    lastStatus' = lastStatus,
    lastOk' = lastOk,
    oks' = oks,
    valid' = valid,
  }
  action step = any { check, done }

  // An error, timeout or missing tool never counts as passing, whatever was expected.
  val errorNeverPasses = lastOk implies Set("holds", "fails").contains(lastStatus)
  // A run with no checks, or with any check not as expected, is never valid.
  val noVacuousPass = valid implies (oks.length() > 0 and oks.indices().forall(i => oks[i]))
}

// The bugs the properties must catch: anything but a counterexample passes a `holds` check, and
// an empty run is valid.
module VerdictBefore {
  pure val EXPECTS = Set("holds", "fails")
  pure val STATUSES = Set("holds", "fails", "error", "timeout", "unavailable")
  var lastExpect: str
  var lastStatus: str
  var lastOk: bool
  var oks: List[bool]
  var valid: bool

  pure def asExpected(status: str, expected: str): bool =
    if (expected == "holds") status != "fails" else status == "fails"
  pure def validRun(flags: List[bool]): bool = flags.foldl(true, (sofar, flag) => sofar and flag)

  action init = all {
    lastExpect' = "holds",
    lastStatus' = "error",
    lastOk' = false,
    oks' = [],
    valid' = validRun([]),
  }
  action check = {
    nondet expected = EXPECTS.oneOf()
    nondet status = STATUSES.oneOf()
    val ok = asExpected(status, expected)
    all {
      oks.length() < 3,
      lastExpect' = expected,
      lastStatus' = status,
      lastOk' = ok,
      oks' = oks.append(ok),
      valid' = validRun(oks.append(ok)),
    }
  }
  action done = all {
    oks.length() == 3,
    lastExpect' = lastExpect,
    lastStatus' = lastStatus,
    lastOk' = lastOk,
    oks' = oks,
    valid' = valid,
  }
  action step = any { check, done }

  val errorNeverPasses = lastOk implies Set("holds", "fails").contains(lastStatus)
  val noVacuousPass = valid implies (oks.length() > 0 and oks.indices().forall(i => oks[i]))
}
