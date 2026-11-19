'use strict';

// Returns the items of one page (pages start at 1) and the total page count.
function paginate(items, page, pageSize) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize');
  const pages = Math.floor(items.length / pageSize);
  if (page < 1 || page > Math.max(pages, 1)) return { items: [], pages };
  const start = page * pageSize;
  return { items: items.slice(start, start + pageSize), pages };
}

module.exports = { paginate };
