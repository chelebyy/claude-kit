Fixed `files.js`; `node test.js` passes, and `test.js` is unchanged. The old code deleted `../`, altering valid paths, and used a prefix check that could accept sibling directories; the replacement normalizes the path and rejects parent traversal or cross-drive results using `path.relative`. This safely enforces lexical containment, assuming symlinks/junctions cannot redirect access outside the root.

Local code review: nothing actionable found.  
Local security review: nothing actionable found within that scope.