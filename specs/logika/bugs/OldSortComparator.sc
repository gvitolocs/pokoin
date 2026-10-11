// #Sireum #Logika
// Must FAIL: `partial_cmp(..).unwrap_or(Equal)` (the comparator before
// pokoin-sort) is not transitive once NaN is in the slice: 1 = NaN = 2 but
// 1 < 2, which is what made the Rust sort panic on 2026-10-10.
import org.sireum._

@strictpure def oldCmp(l: F64, r: F64): Z =
  if (l < r) -1 else if (l > r) 1 else 0

@pure def oldEqualIsTransitive(a: F64, b: F64, c: F64): Unit = {
  Contract(
    Requires(oldCmp(a, b) == 0, oldCmp(b, c) == 0),
    Ensures(oldCmp(a, c) == 0)
  )
}
