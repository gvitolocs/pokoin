import mascotUrl from '@market/assets/pokoin-mascot@8x.png';

/** The official Pokoin wordmark (same markup as market/src/components/PokoinWordmark.jsx). */
export default function PokoinWordmark(props) {
  return (
    <span class={['brand-word', props.class]} aria-hidden="true">
      <span class="brand-letters">P</span>
      <img class="brand-coin" src={mascotUrl} alt="" width="26" height="24" />
      <span class="brand-letters">ko<span class="brand-i">ı</span>n</span>
    </span>
  );
}
