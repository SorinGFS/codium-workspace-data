// Decode persisted JSON Lines notifications and drain partial successes even after a nonzero CLI exit.

import { StringDecoder } from 'node:string_decoder';
import { parsePublicationEvent, PublicationEvent } from './state';

export class PublicationResultStream {
    private readonly decoder = new StringDecoder('utf8');
    private pending = '';
    private work: Promise<void> = Promise.resolve();
    private failure: unknown;
    private failed = false;

    // Preserve notification order without performing metadata writes in the editor.
    public constructor(private readonly observe: (event: PublicationEvent) => Promise<void> | void) {}

    // Preserve split Unicode sequences and incomplete JSON records across arbitrary pipe chunk boundaries.
    public push(chunk: Buffer): void {
        this.pending += this.decoder.write(chunk);
        let separator;
        // Queue complete records only; diagnostics are carried on the separate stderr stream.
        while ((separator = this.pending.indexOf('\n')) >= 0) {
            const line = this.pending.slice(0, separator);
            this.pending = this.pending.slice(separator + 1);
            this.work = this.work.then(async () => {
                if (!this.failed) {
                    try {
                        await this.observe(parsePublicationEvent(line));
                    } catch (error) {
                        this.failed = true;
                        this.failure = error;
                    }
                }
            });
        }
    }

    // Flush persisted notifications before surfacing truncated results or failed observation.
    public async finish(): Promise<void> {
        this.pending += this.decoder.end();
        await this.work;
        if (this.failed) {
            const detail = this.failure instanceof Error ? this.failure.message : String(this.failure);
            throw new Error(`Unable to observe publication: ${detail}. Remote changes may already exist; review GitHub before retrying.`);
        }
        if (this.pending.length) {
            throw new Error('Incomplete publication result; remote changes may already exist.');
        }
    }
}
