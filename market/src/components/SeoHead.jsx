import { useEffect } from 'react';
import { applySeoHead } from '../seo-head.js';

export default function SeoHead({
  title,
  description,
  canonical,
  noindex = false,
  image,
  imageAlt,
  jsonLd,
}) {
  const encodedLd = JSON.stringify(jsonLd || null);
  useEffect(() => applySeoHead({
    title,
    description,
    canonical,
    noindex,
    image,
    imageAlt,
    jsonLd: encodedLd ? JSON.parse(encodedLd) : null,
  }), [title, description, canonical, noindex, image, imageAlt, encodedLd]);
  return null;
}
