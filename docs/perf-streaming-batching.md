# Speed up text + image generation pipeline

## Context
Currently, `generateSpectrumPrompts` must fully complete before any image generation begins (App.jsx:714-744). This means users wait for the entire LLM response, then wait again for all images. Additionally, each image completion triggers a separate `setNodes` call, causing N re-renders.

## Changes

### 1. Stream spectrum prompts and start image gen as each arrives
**Files**: `src/genai.js`, `src/App.jsx`

**genai.js** — new `streamSpectrumPrompts` function:
- Use `ai.models.generateContentStream()` instead of `generateContent()`
- Accumulate text chunks, and each time a complete `<prompt>...</prompt>` is detected, yield it via a callback or async generator
- Keep the non-streaming version as fallback

**App.jsx** (lines ~714-744) — consume the stream:
- Replace the `.then(prompts => ...)` pattern with an async loop over streamed prompts
- As each prompt arrives: update that node's prompt in state, immediately fire `generateImage()` for that node
- This means the first image starts generating as soon as the first prompt is ready, rather than waiting for all N prompts

### 2. Batch image state updates
**File**: `src/App.jsx`

- Instead of each `generateImage().then()` calling `setNodes` individually (N calls), collect results and batch:
  - Option A: Use a ref to accumulate completed image URLs, flush to state on `requestAnimationFrame` or a short debounce (~100ms)
  - Option B: Use `Promise.allSettled` on a sliding window and update state per batch
- Recommendation: Option A (ref + rAF flush) — simpler, natural batching with React's render cycle

## Verification
- Drop an image, create a spectrum with 4-5 nodes, enter a dimension
- Observe: first images should start appearing before the last prompt is generated
- Check console logs: `[node X generating image]` should interleave with prompt streaming, not all appear at once after prompts finish
- Verify no regressions: error handling still works, loading states still show correctly
