'use strict';

/** Ordinary English suggest already carries nationality on the Meili hit. */
function catalogSqlNeeded(groups, language) {
  const lang = String(language || 'en').trim().toLowerCase();
  let nationality = false;
  for (const group of groups || []) {
    for (const printing of group.printings || []) {
      if (!String(printing.nationality || '').trim()) nationality = true;
    }
  }
  return {
    nationality,
    title: lang !== 'en' && lang !== '',
  };
}

module.exports = { catalogSqlNeeded };
