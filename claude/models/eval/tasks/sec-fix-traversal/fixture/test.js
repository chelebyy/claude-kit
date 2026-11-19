'use strict';
const assert = require('assert');
const path = require('path');
const { resolveInside } = require('./files');

const root = path.resolve(__dirname, 'data');
const ok = (p, want) => assert.strictEqual(resolveInside(root, p), path.join(root, want), `should allow ${JSON.stringify(p)}`);
const bad = p => assert.throws(() => resolveInside(root, p), /escapes root/, `should reject ${JSON.stringify(p)}`);

ok('a.txt', 'a.txt');
ok('docs/report.pdf', 'docs/report.pdf');
ok('docs/../a.txt', 'a.txt');
ok('.', '.');
ok('..data', '..data'); // a name that starts with two dots is still inside

bad('../secret.txt');
bad('docs/../../secret.txt');
bad('../data-backup/x.txt'); // sibling folder whose name starts with the root's name
ok('....//data-backup/x.txt', '..../data-backup/x.txt'); // "...." is an ordinary folder name, not a parent step
if (process.platform === 'win32') {
  bad('..\\secret.txt');
  bad('..\\data-backup\\x.txt');
}

console.log('ok');
