'use strict';
const assert = require('node:assert');
const { paginate } = require('./paginate.js');

const ten = Array.from({ length: 10 }, (_, i) => i + 1);

assert.deepStrictEqual(paginate(ten, 1, 3), { items: [1, 2, 3], pages: 4 });
assert.deepStrictEqual(paginate(ten, 4, 3), { items: [10], pages: 4 });
assert.deepStrictEqual(paginate(ten, 5, 3), { items: [], pages: 4 });
assert.deepStrictEqual(paginate(ten, 2, 5), { items: [6, 7, 8, 9, 10], pages: 2 });
assert.deepStrictEqual(paginate([], 1, 5), { items: [], pages: 0 });
assert.throws(() => paginate(ten, 1, 0), RangeError);

console.log('ok');
