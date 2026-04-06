## What does this PR do?
<!-- One-liner. -->

## Type
- [ ] Language preprocessor (new language support)
- [ ] Preprocessor fix (edge case, parser bug)
- [ ] Compressor (new or improved)
- [ ] Pipeline feature
- [ ] Bug fix
- [ ] Docs

## Test results
```
<!-- Paste output of: npx refactory test run -->
```

## For language preprocessors
- [ ] Added to `src/languages/index.js` registry
- [ ] Handles multi-line declarations
- [ ] Handles nested functions/classes
- [ ] Handles language-specific string literals
- [ ] Tested on at least 3 real files (>500 lines each)
- [ ] No `require('fs')`, `require('child_process')`, or network calls in the preprocessor itself

## For compressors
- [ ] Round-trip test passes (compress → decompress = original)
- [ ] No content modification (comments, logic, structure preserved)
- [ ] Net savings > 0 on test corpus

## Breaking changes?
<!-- Does this change existing behavior? -->
