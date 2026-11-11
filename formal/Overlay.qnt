// How `--change <name>` and the gate overlay an OpenSpec change's delta specs on the main specs.
// Assumptions: three requirement ids; a change may add or modify (`delta`) and remove (`removed`)
// any of them, but never both for the same id. `result` holds each surviving requirement with the
// place its links come from.
module Overlay {
  pure val IDS = Set("a", "b", "c")
  var main: Set[str]
  var delta: Set[str]
  var removed: Set[str]
  var result: Set[(str, str)]

  pure def overlay(m: Set[str], d: Set[str], r: Set[str]): Set[(str, str)] =
    m.exclude(d.union(r)).map(id => (id, "main")).union(d.map(id => (id, "change")))

  action init = {
    nondet m = IDS.powerset().oneOf()
    nondet d = IDS.powerset().oneOf()
    nondet r = IDS.exclude(d).powerset().oneOf()
    all { main' = m, delta' = d, removed' = r, result' = overlay(m, d, r) }
  }
  action step = {
    nondet m = IDS.powerset().oneOf()
    nondet d = IDS.powerset().oneOf()
    nondet r = IDS.exclude(d).powerset().oneOf()
    all { main' = m, delta' = d, removed' = r, result' = overlay(m, d, r) }
  }

  // The change's links replace the main ones, and removed requirements disappear.
  val overlaySound = result.forall(entry => and {
    not(removed.contains(entry._1)),
    entry._2 == "main" implies not(delta.contains(entry._1)),
  })
}

// The bug the property must catch: main links are kept next to the change's links.
module OverlayBefore {
  pure val IDS = Set("a", "b", "c")
  var main: Set[str]
  var delta: Set[str]
  var removed: Set[str]
  var result: Set[(str, str)]

  pure def overlay(m: Set[str], d: Set[str], r: Set[str]): Set[(str, str)] =
    m.map(id => (id, "main")).union(d.map(id => (id, "change")))

  action init = {
    nondet m = IDS.powerset().oneOf()
    nondet d = IDS.powerset().oneOf()
    nondet r = IDS.exclude(d).powerset().oneOf()
    all { main' = m, delta' = d, removed' = r, result' = overlay(m, d, r) }
  }
  action step = {
    nondet m = IDS.powerset().oneOf()
    nondet d = IDS.powerset().oneOf()
    nondet r = IDS.exclude(d).powerset().oneOf()
    all { main' = m, delta' = d, removed' = r, result' = overlay(m, d, r) }
  }

  val overlaySound = result.forall(entry => and {
    not(removed.contains(entry._1)),
    entry._2 == "main" implies not(delta.contains(entry._1)),
  })
}
