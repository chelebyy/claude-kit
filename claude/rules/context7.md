---
alwaysApply: true
---

Use Context7 MCP when current library, framework, or API documentation could change the answer: setup and configuration, API signatures, version-specific behavior, and migrations. Skip it for general programming concepts, refactoring, or when the project's own code already shows the usage.

## Steps

1. Call `resolve-library-id` with the library name and the user's question
2. Pick the best match — prefer exact names and version-specific IDs when a version is mentioned
3. Call `query-docs` with the selected library ID and the user's question
4. Answer from the fetched docs and cite the version they describe
