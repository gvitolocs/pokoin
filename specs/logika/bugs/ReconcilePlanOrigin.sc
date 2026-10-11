// #Sireum #Logika
// MUST FAIL: ReconcilePlan.sc with the user_data_field link rule of
// origin/main (2fc7ea48). The contract of attachFixed (only listings not
// linked to a CardTrader product, each at most once) and of planFixed (never
// link and remove one listing) cannot be established. FINDINGS L1; the
// concrete counterexample is the Rust test
// sync_core::tests::user_data_field_never_relinks_a_listing_linked_elsewhere.
// Slang port of the destructive half of `plan_inventory_reconcile`
// (pokoin-rust/crates/external/src/cardtrader/sync_core.rs, after PR #309)
// and of the link it may plan through a product's `user_data_field`.
//
// Abstraction (see README):
// - a listing is its `source_listing_id` read by `parse_ct_product_id`:
//   0 = not CardTrader-linked (no `ct:` prefix), -1 = `ct:` but no product
//   id (the `ct:pending:<event>` push claim), > 0 = the CardTrader product id;
//   plus the two facts `settled_absent` reads (sold out at quantity <= 0, and
//   the product link's `missing_from_ct`);
// - a product is its (positive, understood) id and the listing its
//   `user_data_field = pokoin:<listing>` names (-1 when none or unknown);
// - `unparsed` is `export.unparsed_rows`, `gateOk` is
//   `destructive_reconcile_gate(complete, export_ok, true)`;
// - the facet match and the import path only add `by_source_id` entries for
//   products that ARE in the export, which can never be removal candidates,
//   so they are left out; linked rows have distinct sources (the
//   `UniqueLink` invariant of specs/tla/ct-reconcile).
import org.sireum._

@datatype class Product(val id: Z, val udf: Z)

@datatype class Listing(val src: Z, val soldOutAtZero: B, val linkMissing: B)

object ReconcilePlan {
  val MASS_REMOVAL_MIN: Z = 100

  @strictpure def inExport(ps: ISZ[Product], id: Z): B = ∃(ps.indices)(j => ps(j).id == id)

  // settled_absent: sold out at zero, its product link already missing_from_ct.
  @strictpure def settled(l: Listing): B = l.src > 0 & l.soldOutAtZero & l.linkMissing

  // A removal candidate: linked to a product id the export does not have.
  @strictpure def candidate(ps: ISZ[Product], l: Listing): B =
    l.src > 0 & !inExport(ps, l.src) & !settled(l)

  // `linked_before`: every by_source_id entry (any `ct:` source) not settled.
  @strictpure def countedBefore(l: Listing): B = l.src != 0 & !settled(l)

  @strictpure def productsOk(ps: ISZ[Product]): B = ∀(ps.indices)(j => ps(j).id > 0)

  // by_source_id lookup of `ct:<id>` among the rows loaded for the run.
  @strictpure def alreadyLinked(ls: ISZ[Listing], id: Z): B = ∃(ls.indices)(k => ls(k).src == id)

  @strictpure def validIndex(ls: ISZ[Listing], i: Z): B = 0 <= i & i < ls.size

  // Total accessors. Indexing with a computed index under || / && inside a
  // quantifier made the Logika path condition unsatisfiable (every later
  // obligation "verified" vacuously), so contracts and invariants index
  // only through these. specs/logika/run.sh probes reachability.
  @strictpure def srcAt(ls: ISZ[Listing], x: Z): Z = if (0 <= x & x < ls.size) ls(x).src else 0
  @strictpure def zAt(zs: ISZ[Z], x: Z): Z = if (0 <= x & x < zs.size) zs(x) else 0
  @strictpure def bAt(bs: ISZ[B], x: Z): B = if (0 <= x & x < bs.size) bs(x) else F

  // ---------------------------------------------------------------------
  // Attachment by user_data_field (resolve_product_attachment's second
  // branch) for every product of the export. Returns, per product, the
  // listing it is linked to (-1 = none). FIXED: a listing already linked to
  // another CardTrader product (or linked earlier in this plan) is not
  // re-linked; the product is Unresolved instead.
  def attachFixed(ps: ISZ[Product], ls: ISZ[Listing]): ISZ[Z] = {
    Contract(
      Requires(productsOk(ps)),
      Ensures(
        Res[ISZ[Z]].size == ps.size,
        // only listings that were not linked to a CardTrader product
        ∀(ps.indices)(i => Res[ISZ[Z]](i) == -1 |
          (validIndex(ls, Res[ISZ[Z]](i)) & srcAt(ls, Res[ISZ[Z]](i)) <= 0)),
        // and each at most once
        ∀(ps.indices)(i => ∀(ps.indices)(j =>
          (i != j & Res[ISZ[Z]](i) != -1) ->: (Res[ISZ[Z]](i) != Res[ISZ[Z]](j))))
      )
    )
    // `src` is by_listing_id's view of each row's source, updated on link.
    var src: ISZ[Z] = ISZ.create(ls.size, 0)
    var k: Z = 0
    while (k < ls.size) {
      Invariant(
        Modifies(k, src),
        0 <= k, k <= ls.size, src.size == ls.size,
        ∀(0 until k)(m => src(m) == ls(m).src)
      )
      src = src(k ~> ls(k).src)
            k = k + 1
    }
    var link: ISZ[Z] = ISZ.create(ps.size, -1)
    var i: Z = 0
    while (i < ps.size) {
      Invariant(
        Modifies(i, link, src),
        0 <= i, i <= ps.size, link.size == ps.size, src.size == ls.size,
        // a row's source is still the loaded one, or a product id we linked
        ∀(ls.indices)(m => src(m) > 0 | src(m) == ls(m).src),
        ∀(i until ps.size)(j => link(j) == -1),
        ∀(0 until i)(j => link(j) == -1 |
          (validIndex(ls, link(j)) & srcAt(ls, link(j)) <= 0 & zAt(src, link(j)) > 0)),
        ∀(0 until i)(a => ∀(0 until i)(b =>
          (a != b & link(a) != -1) ->: (link(a) != link(b))))
      )
      val p = ps(i)
            if (!alreadyLinked(ls, p.id) & validIndex(ls, p.udf)) {
        // origin/main: whatever listing user_data_field names is linked, even
        // one linked to another CardTrader product or linked earlier in the run
        link = link(i ~> p.udf)
      }
      i = i + 1
    }
    return link
  }

  // ---------------------------------------------------------------------
  // Removal candidates, the unparsed gate and the mass-removal guard.
  // Returns, per listing, whether the plan removes it.
  def removals(ps: ISZ[Product], ls: ISZ[Listing], unparsed: Z, gateOk: B): ISZ[B] = {
    Contract(
      Requires(unparsed >= 0),
      Ensures(
        Res[ISZ[B]].size == ls.size,
        // Never Remove a listing whose product is in the export.
        ∀(ls.indices)(l => Res[ISZ[B]](l) ->: (ls(l).src > 0 & !inExport(ps, ls(l).src))),
        // Never re-plan a settled listing.
        ∀(ls.indices)(l => Res[ISZ[B]](l) ->: !settled(ls(l))),
        // An export with an unreadable id, or a failed/incomplete one, removes nothing.
        (unparsed > 0 | !gateOk) ->: ∀(ls.indices)(l => !Res[ISZ[B]](l)),
        // Otherwise either every candidate goes, or none does (guard).
        (∃(ls.indices)(l => Res[ISZ[B]](l))) ->:
          ∀(ls.indices)(l => candidate(ps, ls(l)) ->: Res[ISZ[B]](l))
      )
    )
    val allow: B = gateOk & unparsed == 0
    var remove: ISZ[B] = ISZ.create(ls.size, F)
    var planned: Z = 0
    var before: Z = 0
    var l: Z = 0
    while (l < ls.size) {
      Invariant(
        Modifies(l, remove, planned, before),
        0 <= l, l <= ls.size, remove.size == ls.size,
        0 <= planned, planned <= before,
        ∀(0 until l)(m => remove(m) == (allow & candidate(ps, ls(m)))),
        ∀(l until ls.size)(m => !remove(m)),
        (planned == 0) ->: ∀(0 until l)(m => !remove(m))
      )
      if (countedBefore(ls(l))) {
        before = before + 1
      }
      if (allow & candidate(ps, ls(l))) {
        remove = remove(l ~> T)
                planned = planned + 1
      }
      l = l + 1
    }
    // mass_removal_guard
    if (planned > MASS_REMOVAL_MIN & planned * 2 > before) {
      remove = ISZ.create(ls.size, F)
          }
    return remove
  }

  // ---------------------------------------------------------------------
  // The whole plan never links a listing and removes it in the same run.
  def planFixed(ps: ISZ[Product], ls: ISZ[Listing], unparsed: Z, gateOk: B): (ISZ[Z], ISZ[B]) = {
    Contract(
      Requires(productsOk(ps), unparsed >= 0),
      Ensures(
        Res[(ISZ[Z], ISZ[B])]._1.size == ps.size,
        Res[(ISZ[Z], ISZ[B])]._2.size == ls.size,
        ∀(ps.indices)(i => Res[(ISZ[Z], ISZ[B])]._1(i) == -1 |
          (validIndex(ls, Res[(ISZ[Z], ISZ[B])]._1(i)) & !bAt(Res[(ISZ[Z], ISZ[B])]._2, Res[(ISZ[Z], ISZ[B])]._1(i))))
      )
    )
    val link = attachFixed(ps, ls)
    val remove = removals(ps, ls, unparsed, gateOk)
        return (link, remove)
  }
}
