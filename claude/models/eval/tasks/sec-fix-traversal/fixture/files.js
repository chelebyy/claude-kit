'use strict';
const path = require('path');

// Resolves a user-supplied relative path inside `root` and returns the absolute path.
// Throws if the result would be outside `root`. `root` itself is allowed.
function resolveInside(root, userPath) {
  const base = path.resolve(root);
  const clean = userPath.replace(/\.\.\//g, ''); // drop parent-directory steps
  const target = path.join(base, clean);
  if (!target.startsWith(base)) throw new Error('path escapes root');
  return target;
}

module.exports = { resolveInside };
