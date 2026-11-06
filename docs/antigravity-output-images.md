# Antigravity output images

Antigravity `inlineData` responses become durable DSH image blocks in both
`stream()` (SSE) and `generate()` (JSON). A successfully stored image counts as
content, including when it is the entire answer. No account-pool policy changes
are involved beyond the normal empty-response failover.

## Contract and implementation

The host output shape is `{ type: 'image', attachment: ImageAttachmentRef }`.
The `{ type: 'image', mediaType, dataBase64 }` shape is the resolved **request**
representation, not a durable assistant block.

The translator awaits `AttachmentStore.saveImage()` before emitting the image's
`block-start` and `block-end`. It closes preceding text/reasoning blocks first,
so later text cannot merge across an image. Every image occurrence gets a new
index, including identical images in different frames. Thought signatures
survive storage and replay. Assistant image resolution keeps one output block
per input block; user/tool image editing hints are unchanged.

Assistant history carries attachment references rather than base64. Replay reads
bytes through `resolveImages()`, then `toAntigravityContents()` restores
`inlineData` and signatures for the originating route. Host normalization can
change encoded bytes; replay uses the stored, validated image.

Usage precedes finish. The latest usage snapshot is retained when the terminal
frame has none. STOP, tool-call, MAX_TOKENS, and content-filter completion
semantics remain. EOF or `[DONE]` without a finish reason is a truncated stream,
and a JSON response without a finish reason also fails.

A Gemini inline image marked `thought: true` is an intermediate sketch, not an
answer attachment. It is omitted from visible history and request replay. Only
final image bytes are saved. A sketch without final output yields
`EMPTY_RESPONSE`.

## Admission and failure boundaries

- Accept canonical padded base64 and host-supported PNG, JPEG, WebP, and GIF.
  Reject empty data, data URLs, malformed base64, and unsupported MIME types
  without copying the payload into diagnostics.
- Enforce per-image and aggregate byte/count limits across one response. These
  output limits are separate from request-side image offloading and budgets.
- Delegate raster decoding, MIME verification, pixel/dimension checks,
  normalization, and durable writes to the attachment store.
- Missing storage, bad images, output limits, and local storage failures report
  `UNSUPPORTED`, `INVALID_IMAGE_RESPONSE`, `IMAGE_OUTPUT_LIMIT`, or
  `IMAGE_OUTPUT_STORAGE`. They do not trigger account cooldowns. Genuine empty
  responses use ordinary pool failover without a cooldown.
- The existing HTTP/SSE parser buffers each JSON frame before admission; this
  feature does not add a transport frame-size cap. A failure after earlier
  frames can leave saved but unreferenced objects under host-owned retention.

## Verification and limits

`test/antigravity-images.spec.ts` injects responses through the real adapter,
pool, host block assembler, and replay path. It covers SSE/JSON, image-only and
mixed answers, multiple frames, signatures, usage, malformed or truncated
inputs, admission limits, cancellation, and missing/failing storage. The unit
attachment store validates fixture behavior; it is not a full raster decoder.
The regular host-export, host-contract, boot, and host E2E gates still apply.

No live Antigravity generation or credentials are used. Interactive gallery
layout, provider acceptance, and live account eligibility remain manual
acceptance checks.
