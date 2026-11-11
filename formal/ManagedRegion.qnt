// What `specify init` does to the agent instruction file, run any number of times.
// Assumptions: the file is abstracted to three counts: Specify's own `formal-workflow` regions,
// regions left by older Specify versions (at most two kinds), and blocks of the user's own text
// (at most two). Between runs the user may edit their own text. `kept` records whether the last
// init left the user's text as it was.
module ManagedRegion {
  var regions: int
  var legacy: int
  var userText: int
  var initialized: bool
  var kept: bool

  action init = {
    nondet l = 0.to(2).oneOf()
    nondet u = 0.to(2).oneOf()
    all { regions' = 0, legacy' = l, userText' = u, initialized' = false, kept' = true }
  }
  action runInit = all {
    regions' = 1,
    legacy' = 0,
    userText' = userText,
    initialized' = true,
    kept' = true,
  }
  action userEdits = {
    nondet u = 0.to(2).oneOf()
    all { regions' = regions, legacy' = legacy, userText' = u, initialized' = initialized, kept' = kept }
  }
  action step = any { runInit, userEdits }

  // After init there is exactly one managed region, no legacy region, and the user's text is kept.
  val oneRegion = initialized implies (regions == 1 and legacy == 0 and kept)
}

// The bug the property must catch: every run appends another region.
module ManagedRegionBefore {
  var regions: int
  var legacy: int
  var userText: int
  var initialized: bool
  var kept: bool

  action init = {
    nondet l = 0.to(2).oneOf()
    nondet u = 0.to(2).oneOf()
    all { regions' = 0, legacy' = l, userText' = u, initialized' = false, kept' = true }
  }
  action runInit = all {
    regions < 3,
    regions' = regions + 1,
    legacy' = 0,
    userText' = userText,
    initialized' = true,
    kept' = true,
  }
  action userEdits = {
    nondet u = 0.to(2).oneOf()
    all { regions' = regions, legacy' = legacy, userText' = u, initialized' = initialized, kept' = kept }
  }
  action step = any { runInit, userEdits }

  val oneRegion = initialized implies (regions == 1 and legacy == 0 and kept)
}
