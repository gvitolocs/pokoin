import { Portal } from '@solidjs/web';
import { boxNameAskTitle, boxNameChoiceLabels } from '@market/box-name.js';
import { useDialogFocus } from '../lib/dialog-focus.js';

/**
 * The question a typed box name raises when it ends in a number: is the number
 * part of the name, or the stack inside the box? Only the seller splits it, so
 * Escape and a click outside answer the first button — which is also what is
 * already applied. `reading` is the `ambiguousBoxName` answer for the name.
 */
export default function BoxNameAsk(props) {
  const labels = () => boxNameChoiceLabels(props.reading);
  let box;
  const onKey = useDialogFocus(() => box, {
    onClose: () => props.onAnswer?.('box'),
    first: () => box?.querySelector('.box-name-ask-keep'),
  });
  const dismiss = (event) => {
    if (event.target === box) props.onAnswer?.('box');
  };
  return (
    <Portal mount={document.body}>
      <div
        class="box-name-ask"
        role="dialog"
        aria-modal="true"
        aria-labelledby="box-name-ask-title"
        ref={(el) => { box = el; }}
        onKeyDown={onKey}
        onClick={dismiss}
      >
        <div class="box-name-ask-card">
          <p id="box-name-ask-title" class="box-name-ask-title">{boxNameAskTitle(props.reading)}</p>
          <p class="box-name-ask-note">Nothing is split unless you say so.</p>
          <div class="box-name-ask-actions">
            <button type="button" class="box-name-ask-keep" onClick={() => props.onAnswer?.('box')}>
              {labels().asBox}
            </button>
            <button type="button" class="box-name-ask-split" onClick={() => props.onAnswer?.('stack')}>
              {labels().asStack}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
