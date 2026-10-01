"use strict";
// Decode persisted JSON Lines notifications and drain partial successes even after a nonzero CLI exit.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PublicationResultStream = void 0;
const node_string_decoder_1 = require("node:string_decoder");
const state_1 = require("./state");
class PublicationResultStream {
    observe;
    decoder = new node_string_decoder_1.StringDecoder('utf8');
    pending = '';
    work = Promise.resolve();
    failure;
    failed = false;
    // Preserve notification order without performing metadata writes in the editor.
    constructor(observe) {
        this.observe = observe;
    }
    // Preserve split Unicode sequences and incomplete JSON records across arbitrary pipe chunk boundaries.
    push(chunk) {
        this.pending += this.decoder.write(chunk);
        let separator;
        // Queue complete records only; diagnostics are carried on the separate stderr stream.
        while ((separator = this.pending.indexOf('\n')) >= 0) {
            const line = this.pending.slice(0, separator);
            this.pending = this.pending.slice(separator + 1);
            this.work = this.work.then(async () => {
                if (!this.failed) {
                    try {
                        await this.observe((0, state_1.parsePublicationEvent)(line));
                    }
                    catch (error) {
                        this.failed = true;
                        this.failure = error;
                    }
                }
            });
        }
    }
    // Flush persisted notifications before surfacing truncated results or failed observation.
    async finish() {
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
exports.PublicationResultStream = PublicationResultStream;
//# sourceMappingURL=publicationStream.js.map