import { writeSync } from 'node:fs';
import { spec } from 'node:test/reporters';
import { Readable } from 'node:stream';

export const pluginTestReporterUrl = import.meta.url;

// Keep raw stdout/stderr in the ordinary report. The parent redacts that report
// as a whole, so secrets split across writes cannot escape through live output.
export default async function* reporter(source) {
  yield* Readable.from(source).compose(async function* progress(events) {
    for await (const event of events) {
      if (['test:dequeue', 'test:pass', 'test:fail', 'test:diagnostic'].includes(event.type)) {
        const { file, name, message, details, skip } = event.data;
        writeSync(3, JSON.stringify({
          event: event.type.slice(5), file, name, message,
          durationMs: details?.duration_ms, skip,
        }) + '\n');
      }
      yield event;
    }
  }).compose(new spec());
}
