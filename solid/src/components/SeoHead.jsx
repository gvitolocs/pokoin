import { createEffect } from 'solid-js';
import { applySeoHead } from '@market/seo-head.js';

/** Head tags for the current page (market/src/seo-head.js, shared with React). */
export default function SeoHead(props) {
  createEffect(
    () => ({
      title: props.title,
      description: props.description,
      canonical: props.canonical,
      noindex: Boolean(props.noindex),
      image: props.image,
      imageAlt: props.imageAlt,
      jsonLd: props.jsonLd || null,
    }),
    (head) => applySeoHead(head),
  );
  return null;
}
