// #Sireum #Logika
// Slang port of pokoin-rust/crates/sort/src/lib.rs (cmp_f64, cmp_f64_desc,
// cmp_f64_nan_last). Ordering is -1 (Less), 0 (Equal), 1 (Greater).
// F64 is IEEE-754 binary64 (SMT-LIB FloatingPoint), so NaN, -0.0 and the
// infinities are all in the quantified domain.
import org.sireum._

// `left.partial_cmp(&right).unwrap_or(Equal)` for non-NaN operands.
@strictpure def partialCmp(l: F64, r: F64): Z =
  if (l < r) -1 else if (l > r) 1 else 0

// cmp_f64_nan_last: numbers in partial_cmp order (reversed when
// descending), NaN after every number in both directions.
@strictpure def cmpNanLast(l: F64, r: F64, descending: B): Z =
  if (!l.isNaN && !r.isNaN) (if (descending) -partialCmp(l, r) else partialCmp(l, r))
  else if (l.isNaN && r.isNaN) 0
  else if (l.isNaN) 1
  else -1

@strictpure def cmpF64(l: F64, r: F64): Z = cmpNanLast(l, r, F)
@strictpure def cmpF64Desc(l: F64, r: F64): Z = cmpNanLast(l, r, T)

// The comparator the 2026-10-10 panics came from.
@strictpure def oldCmp(l: F64, r: F64): Z = partialCmp(l, r)

@pure def rangeOk(a: F64, b: F64, d: B): Unit = {
  Contract(Ensures(-1 <= cmpNanLast(a, b, d) & cmpNanLast(a, b, d) <= 1))
}

@pure def reflexive(a: F64, d: B): Unit = {
  Contract(Ensures(cmpNanLast(a, a, d) == 0))
}

@pure def antisymmetric(a: F64, b: F64, d: B): Unit = {
  Contract(Ensures(cmpNanLast(a, b, d) == -cmpNanLast(b, a, d)))
}

@pure def transitive(a: F64, b: F64, c: F64, d: B): Unit = {
  Contract(
    Requires(cmpNanLast(a, b, d) <= 0, cmpNanLast(b, c, d) <= 0),
    Ensures(cmpNanLast(a, c, d) <= 0)
  )
}

@pure def strictTransitive(a: F64, b: F64, c: F64, d: B): Unit = {
  Contract(
    Requires(cmpNanLast(a, b, d) < 0, cmpNanLast(b, c, d) < 0),
    Ensures(cmpNanLast(a, c, d) < 0)
  )
}

@pure def equalIsTransitive(a: F64, b: F64, c: F64, d: B): Unit = {
  Contract(
    Requires(cmpNanLast(a, b, d) == 0, cmpNanLast(b, c, d) == 0),
    Ensures(cmpNanLast(a, c, d) == 0)
  )
}

// Numbers keep their order; NaN is last in both directions.
@pure def numbersInOrder(a: F64, b: F64): Unit = {
  Contract(
    Requires(!a.isNaN, !b.isNaN, a < b),
    Ensures(cmpF64(a, b) == -1, cmpF64Desc(a, b) == 1)
  )
}

@pure def nanLast(a: F64, n: F64): Unit = {
  Contract(
    Requires(n.isNaN, !a.isNaN),
    Ensures(cmpF64(n, a) == 1, cmpF64Desc(n, a) == 1)
  )
}
