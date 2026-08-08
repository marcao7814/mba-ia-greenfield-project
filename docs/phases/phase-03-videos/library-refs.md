---
libs:
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-08-06T04:35:00-03:00"
  bullmq:
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-08-06T04:35:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-06T04:20:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-06T04:20:00-03:00"
  fluent-ffmpeg:
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-08-06T04:20:00-03:00"
  nanoid:
    version: "^5.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-08-06T04:50:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-06T04:48:45-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this phase. Pulled via Context7 against the versions compatible with `nestjs-project`'s installed stack (NestJS 11, TypeScript `nodenext`). Re-fetch when the underlying TD changes.

## @nestjs/bullmq (+ bullmq)

**Source:** `/taskforcesh/bullmq` (Context7) — High reputation, 1337 snippets. Maps to `phase-03-videos/TD-01` Decision A (BullMQ).

### Module setup and processor registration

```typescript
// videos.module.ts (or a dedicated QueueModule)
BullModule.registerQueue({
  name: 'video-processing',
  connection: { host: 'redis', port: 6379 }, // Compose service name, never localhost
});

// worker (separate entrypoint / container)
@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string; storageKey: string }>): Promise<void> {
    // ffprobe + screenshots + status transition (TD-04, TD-05)
  }
}
```

### Producer (API side, after `CompleteMultipartUpload` — SI covering TD-03/TD-05)

```typescript
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

async enqueueProcessing(videoId: string, storageKey: string) {
  await this.queue.add(
    'process-video',
    { videoId, storageKey },
    {
      jobId: videoId, // idempotent enqueue — re-adding the same videoId is silently ignored by BullMQ
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }, // closes validation.md IC-1 — native retry, no custom DLX
    },
  );
}
```

### Retry/backoff (closes `validation.md` IC-1 / TD-01 Resolution)

BullMQ's `attempts` + `backoff` on `Queue.add()` are native — `exponential` backoff computes `2^(attemptsMade-1) * delay`, optionally with `jitter`. No dead-letter exchange or custom requeue logic needed, unlike the RabbitMQ path this TD originally (briefly) chose. After the last attempt, the job is marked `failed` by BullMQ; the worker's own `catch` block is where the video's status flips to `error` (TD-05) before re-throwing, since BullMQ's failure bookkeeping has no application-level side effect on its own.

### Job-level timeout

BullMQ has **no built-in `job.opts.timeout`** — a stuck FFmpeg call (TD-04's DoS-relevant concern) must be bounded explicitly inside the processor via `AbortController`:

```typescript
async process(job: Job): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FFMPEG_TIMEOUT_MS);
  try {
    await runFfmpegWithSignal(controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') throw new UnrecoverableError('Timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

`UnrecoverableError` skips further retries for that job (useful for a timeout that will just recur) — distinct from a plain `throw`, which consumes one of the `attempts`.

### Local dev / Compose

`connection.host` must resolve to the Compose service name (`redis`), never `localhost`, per the project's Docker networking rule.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation, 17935 snippets. Maps to `phase-03-videos/TD-02`, `TD-03`, `TD-07`.

### Client configuration (MinIO today, real S3 in production — TD-02)

```typescript
const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT, // http://minio:9000 in Compose — omit entirely in prod to use AWS's default endpoint resolution
  region: process.env.STORAGE_REGION ?? 'us-east-1',
  forcePathStyle: true, // required for MinIO; harmless on real S3
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY!,
    secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  },
});
```

### Multipart upload via presigned part URLs (TD-03)

No single convenience call generates all part URLs — the flow is three explicit commands, each presigned individually:

```typescript
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// per part (client requests these as it uploads, e.g. one at a time or a batch of N):
const partUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: n }),
  { expiresIn: 3600 },
);

// after all parts PUT (client collects ETag per part from the PUT response headers):
await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] },
}));
```

`@aws-sdk/lib-storage`'s `Upload` helper (queueSize/partSize convenience wrapper) is **server-side only** — it performs the multipart calls itself rather than emitting presigned URLs for a remote client, so it does not apply to TD-03's client-direct-to-storage flow. It remains useful if the worker ever needs to upload a generated artifact (e.g., a transcoded rendition) back to storage in a future phase.

### Presigned GET (TD-07 — streaming/download)

```typescript
const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn });
```

S3/MinIO handle `Range`/`206 Partial Content` on this URL natively — no extra code. Sign `x-amz-*` headers (e.g. a forced `Content-Disposition` for download vs. inline streaming) via the `unhoistableHeaders` option if TD-07's download/stream distinction ends up needing different response headers on the same object.

---

## fluent-ffmpeg

**Source:** `/fluent-ffmpeg/node-fluent-ffmpeg` (Context7) — Medium reputation, 340 snippets. Maps to `phase-03-videos/TD-04`.

### Metadata extraction

```typescript
ffmpeg.ffprobe(localFilePath, (err, data) => {
  const durationSeconds = Math.round(data.format.duration);
  const stream = data.streams.find(s => s.codec_type === 'video');
  // stream.codec_name, stream.width, stream.height, data.format.bit_rate
});
```

### Thumbnail at 10% of duration (TD-04 Resolution, closes `validation.md` AMB-1)

```typescript
ffmpeg(localFilePath)
  .screenshots({
    timestamps: ['10%'],
    filename: 'thumbnail.jpg',
    folder: tmpDir,
  })
  .on('end', () => { /* upload tmpDir/thumbnail.jpg via PutObjectCommand */ })
  .on('error', reject);
```

**Load-bearing constraint:** `screenshots()` with a percentage timemark computes the absolute offset from the video's **duration**, which the library obtains via an internal `ffprobe` call — and that call requires **a local file path**, not a remote URL or a Node stream (confirmed in the library's own docs/recipes). This is why the worker must download the object from storage to local disk (e.g., a temp dir) before calling either `ffprobe()` or `screenshots()` — it cannot operate directly on the presigned GET URL from TD-02.

### Dockerfile requirement

`fluent-ffmpeg` shells out to system `ffmpeg`/`ffprobe` — the Video Worker's Docker image needs those binaries installed (e.g., `apt-get install -y ffmpeg` on a Debian-based Node image), separate from the npm dependency.

---

## nanoid

**Source:** `/ai/nanoid` (Context7) — High reputation. Maps to `phase-03-videos/TD-06`.

### ESM-only — compatibility note for this project's TS config

`nestjs-project`'s `tsconfig.json` uses `"module": "nodenext"` with no `"type": "module"` in `package.json`, so the compiled output is CommonJS. **`nanoid@5.x` ships ESM-only** (no CJS `require()` export) — a plain `import { nanoid } from 'nanoid'` at the top of a CommonJS-compiled file will fail at runtime. Two ways to reconcile, to be settled at `implement` time (not a further open decision — same tool, different import mechanics):

```typescript
// Option 1 — dynamic import (works today, minor async overhead, cache the loaded fn):
let nanoidFn: (() => string) | undefined;
async function generateSlug(): Promise<string> {
  if (!nanoidFn) ({ nanoid: nanoidFn } = await import('nanoid'));
  return nanoidFn!();
}

// Option 2 — pin nanoid@3.x (last CJS-compatible major) — simpler call sites, older major.
```

### Custom alphabet / length

```typescript
import { customAlphabet } from 'nanoid';
const generateSlug = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12); // 12 chars, lowercase+digits — URL-safe, no special chars to escape
```

Default `nanoid()` (21 chars, full URL-safe alphabet incl. `-`/`_`) is longer than needed for TD-06's short-URL goal — `customAlphabet` with a 12-char lowercase-alphanumeric set is the closer match to the video-platform-short-id convention TD-06 recommends, at a collision probability still low enough that the DB `UNIQUE` constraint + regenerate-on-conflict (no proactive check) remains sufficient.
