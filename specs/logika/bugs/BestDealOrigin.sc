// #Sireum #Logika
// MUST FAIL: the Best Deal rules before PR #317 (shown grade = chosen grade)
// and the language chips before this branch (built from unpriced offers too).
// FINDINGS L2; tests in market/src/card-desk-deal.test.js.
// Slang port of the Best Deal grade rules in market/src/card-desk.js
// (PR #317): matchDeal, bestDealCondition, shownDealCondition.
//
// Abstraction (see README): an offer is its language code after
// `offerLanguage`, its grade after `moodCondition`, and its price.
// Grades are DEAL_CONDS indices: 0 Poor, 1 PL, 2 MP, 3 SP, 4 NM.
// ANY (-1) is the empty string: "any condition" as an argument, "no grade"
// as bestDealCondition's answer. Language 0 is the empty string (any).
// `moodCondition` always returns one of the five grades (unknown or missing
// condition reads as NM), which is the `wellFormed` precondition.
import org.sireum._

@datatype class Offer(val lang: Z, val grade: Z, val price: Z)

object BestDeal {
  val ANY: Z = -1
  val NM: Z = 4

  @strictpure def isGrade(g: Z): B = 0 <= g & g <= 4

  @strictpure def wellFormed(rows: ISZ[Offer]): B =
    ∀(rows.indices)(i => isGrade(rows(i).grade))

  // pricedOffers: Number(offer.pricePkn) > 0
  @strictpure def priced(o: Offer): B = o.price > 0

  @strictpure def fits(o: Offer, lang: Z, grade: Z): B =
    priced(o) & (lang == 0 | o.lang == lang) & (grade == ANY | o.grade == grade)

  // matchDeal(...) is truthy: pricedOffers(rows).find(...) found an offer.
  @strictpure def matchDeal(rows: ISZ[Offer], lang: Z, grade: Z): B =
    ∃(rows.indices)(i => fits(rows(i), lang, grade))

  // The language has priced offers at all.
  @strictpure def langListed(rows: ISZ[Offer], lang: Z): B =
    ∃(rows.indices)(i => priced(rows(i)) & (lang == 0 | rows(i).lang == lang))

  // Every offer has one of the five grades, so if none of them is listed in
  // a language, that language has no priced offer.
  @pure def noGradeNoOffer(rows: ISZ[Offer], lang: Z): Unit = {
    Contract(
      Requires(wellFormed(rows), ∀(0 to NM)(g => !matchDeal(rows, lang, g))),
      Ensures(!langListed(rows, lang))
    )
  }

  // for (index = DEAL_CONDS.length - 1; index >= 0; index -= 1)
  //   if (matchDeal(rows, language, DEAL_CONDS[index].value)) return value;
  // return '';
  def bestDealCondition(rows: ISZ[Offer], lang: Z): Z = {
    Contract(
      Requires(wellFormed(rows)),
      Ensures(
        // '' only when the language has no priced offer at all
        (Res[Z] == ANY) == !langListed(rows, lang),
        // otherwise a listed grade, and no better grade is listed
        (Res[Z] != ANY) ->: (isGrade(Res[Z]) & matchDeal(rows, lang, Res[Z])),
        (Res[Z] != ANY) ->: ∀(Res[Z] + 1 to NM)(g => !matchDeal(rows, lang, g))
      )
    )
    var index: Z = NM
    while (index >= 0) {
      Invariant(
        Modifies(index),
        -1 <= index,
        index <= NM,
        ∀(index + 1 to NM)(g => !matchDeal(rows, lang, g))
      )
      if (matchDeal(rows, lang, index)) {
        return index
      }
      index = index - 1
    }
    noGradeNoOffer(rows, lang)
    return ANY
  }

  // Before PR #317 (79a55d80^): the deal showed `dealCond || 'NM'`, the
  // chosen grade, whether or not it was listed in the chosen language.
  def shownDealCondition(rows: ISZ[Offer], lang: Z, wanted: Z): Z = {
    Contract(
      Requires(wellFormed(rows), wanted == ANY | isGrade(wanted)),
      Ensures(
        // Whenever the language has priced offers, the shown grade is listed in it.
        langListed(rows, lang) ->: matchDeal(rows, lang, Res[Z])
      )
    )
    return wanted
  }

  // Language chips before this branch: every offer, priced or not.
  @strictpure def chipBefore(rows: ISZ[Offer], lang: Z): B =
    ∃(rows.indices)(i => rows(i).lang == lang)

  // A chip opens a deal with an offer in that language.
  @pure def chipsHaveDeals(rows: ISZ[Offer], lang: Z): Unit = {
    Contract(
      Requires(wellFormed(rows), lang != 0, chipBefore(rows, lang)),
      Ensures(langListed(rows, lang))
    )
  }
}
