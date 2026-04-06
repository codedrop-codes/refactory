---
name: Broken extraction
about: Submit a file that breaks the mechanical extractor
title: "[CORPUS] "
labels: corpus, bug
assignees: ''
---

## What language?
<!-- e.g. JavaScript, Python, TypeScript -->

## What broke?
<!-- Syntax error, missing functions, wrong boundaries, crash, etc. -->

## Error output
```
<!-- Paste the error from refactory or node --check -->
```

## File details
- **Lines:** 
- **Functions:** 
- **Language features used:** <!-- e.g. arrow functions, decorators, async generators, template literals -->

## Can you attach the file?
<!-- 
If the file doesn't contain proprietary code, attach it here.
If it does, run: refactory test submit yourfile.js
This strips secrets automatically. Then describe the pattern that breaks.
-->

## How to reproduce
```bash
# Example:
npx @refactory/mcp analyze yourfile.js
npx @refactory/mcp decompose yourfile.js
```

---
Every submission becomes a permanent test case. The extractor gets stronger with every report.
