/** CLIP versions whose album-hover silhouette is cut from the artofpkm "TCG Gallery"
 * clean artwork (catalog 668, no card text) instead of the leftover scan. Full-art
 * cards only: there the attack text and HP overlay the painting and bit into the
 * scan-cut silhouette. Masks live in `figure-masks-artofpkm/` on both CDN origins,
 * in the same scan frame as `figure-masks-clean/`. Built by tools/clean-art-match;
 * see docs/FIGURE_MASKS.md ("Clean-art silhouettes"). */
export const ARTOFPKM_FIGURE_MASK_REV = 'artofpkm-1';

export const ARTOFPKM_FIGURE_MASK_VERSIONS = new Set([
  'v224036', 'v224308', 'v224474', 'v225444', 'v225636', 'v226550', 'v226590', 'v238174',
  'v240808', 'v240862', 'v244912', 'v251956', 'v253490', 'v254038', 'v254084', 'v254908',
  'v254958', 'v258576', 'v259178', 'v260900', 'v261044', 'v262284', 'v265744', 'v279586',
  'v290118', 'v294330', 'v300608', 'v306008', 'v306040', 'v307868', 'v308036', 'v308040',
  'v316504', 'v316744', 'v316748', 'v316756', 'v316766', 'v316770', 'v322296', 'v322298',
  'v322300', 'v322302', 'v322304', 'v322320', 'v322408', 'v332538', 'v332868', 'v332872',
  'v401422', 'v401490', 'v403582', 'v412902', 'v412950', 'v412974', 'v413036', 'v413038',
  'v413156', 'v413264', 'v413266', 'v413268', 'v413270', 'v413300', 'v424834', 'v424842',
  'v424872', 'v424892', 'v424902', 'v424984', 'v424988', 'v425346', 'v425362', 'v425390',
  'v425410', 'v425442', 'v425462', 'v425472', 'v436040', 'v436076', 'v436094', 'v443298',
  'v443300', 'v443302', 'v451290', 'v451470', 'v455476', 'v455480', 'v455544', 'v455620',
  'v473056', 'v475508', 'v475604', 'v476142', 'v476180', 'v494470', 'v545710', 'v545712',
  'v545826', 'v622280', 'v622298', 'v630816'
]);
