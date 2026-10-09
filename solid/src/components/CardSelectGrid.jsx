/**
 * Same wrapper markup as market/src/components/CardSelectGrid.jsx so grid and
 * rail CSS match. The selection band (shift/cmd multi-select, group drag) is a
 * follow-up slice; until then tiles behave as single links.
 */
export default function CardSelectGrid(props) {
  return (
    <div class={props.contents ? 'card-select-host is-contents' : 'card-select-host'}>
      <div class={props.contents ? ['is-contents', props.class ?? 'grid'] : (props.class ?? 'grid')}>
        {props.children}
      </div>
    </div>
  );
}
