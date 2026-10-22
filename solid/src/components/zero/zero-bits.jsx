import { For, Show } from 'solid-js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '@market/image-urls.js';
import { formatOrderMoney } from '@market/order-status.js';
import { alsoInLabels, issueLabel, lineFacets, lineLocation, lineLocationFromPt, lineQuantity } from '@market/zero-pick.js';

export function lineImage(item) {
  return homepageDerivativeUrl(ownCatalogImage(
    { id: item?.cardId, name: item?.name || '' },
    preferFullImage(item?.imageUrl || ''),
  ));
}

export function linePrice(item) {
  return item?.lineCents != null ? formatOrderMoney(item.lineCents, item.currency) : '';
}

export function lineWhere(item) {
  return [item?.collectorNumber ? `#${item.collectorNumber}` : '', item?.expansion].filter(Boolean).join(' · ');
}

/** The line's pick location, "No location" when there is none, with a PT tag when it came from Power Tools. */
export function LocationText(props) {
  return (
    <>
      {lineLocation(props.item) || 'No location'}
      <Show when={lineLocationFromPt(props.item)}>
        <small class="zero-pt-tag" title="Location from Power Tools"> PT</small>
      </Show>
    </>
  );
}

/** "take 3", "3 of 5" (a split item), "also in: …" (fallback allocation). */
export function TakeBits(props) {
  const quantity = () => lineQuantity(props.item);
  const split = () => Number(props.item.itemQuantity) > quantity();
  return (
    <>
      <Show when={quantity() > 1}><span class="zero-take">take {quantity()}</span></Show>
      <Show when={split()}>
        <span class="zero-split" title="This CardTrader line is split over several places">{quantity()} of {props.item.itemQuantity}</span>
      </Show>
      <Show when={alsoInLabels(props.item).length}>
        <span class="zero-also">also in: {alsoInLabels(props.item).join(', ')}</span>
      </Show>
    </>
  );
}

export function FacetBadges(props) {
  return (
    <span class="zero-facets">
      <For each={lineFacets(props.item)}>{(facet) => <span class="zero-facet">{facet}</span>}</For>
    </span>
  );
}

export function PtPlace(props) {
  const position = () => Number(props.item.powerTools?.position);
  return (
    <Show when={position() > 0}>
      <span
        class={['zero-pt-place', { 'is-warn': Boolean(props.item.powerTools?.mismatch) }]}
        title={props.item.powerTools?.mismatch ? 'In a different place than in Power Tools' : 'Place in Power Tools'}
      >
        PT #{position()}
      </span>
    </Show>
  );
}

export function IssueBadge(props) {
  return (
    <Show when={props.issue}>
      <span class="zero-issue-badge" title={props.issue.note || undefined}>{issueLabel(props.issue)}</span>
    </Show>
  );
}
