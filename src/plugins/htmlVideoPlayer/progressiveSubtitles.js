/**
 * Streams an embedded text subtitle track while the server reads it.
 *
 * The events of a Matroska text track are spread over the whole file, so a full extraction of a
 * remote source has to download all of it before the server returns a single line (40-60 s for a
 * 2-3 GB episode). The server's progressive endpoint reads from the playback position and hands
 * out events as it finds them, far ahead of playback, as ASS event lines (text tracks such as SRT
 * are converted on the way); the renderer starts with the first ones and takes the rest as they
 * come.
 *
 * Event times are absolute, so the events of every read are kept: seeking back and forth (by hand
 * or through SyncPlay) only ever adds to what the renderer has. A seek before the start of the
 * current read, or well past what it has reached, starts a new read from there; viewers watching
 * the same track around the same position share one read on the server.
 */

const TICKS_PER_SECOND = 10000000;
const FIRST_WAIT_MS = 6000;
const POLL_WAIT_MS = 3000;
const RETRY_DELAY_MS = 2000;
// Start a little before the position, for the line already on screen.
const START_MARGIN_TICKS = 5 * TICKS_PER_SECOND;
// A seek this far past what the current read has reached starts a new read from there.
const SEEK_AHEAD_TICKS = 30 * TICKS_PER_SECOND;

const ASS_CODECS = ['ass', 'ssa'];
// Text tracks the server converts to ASS events on the way.
const TEXT_CODECS = ['subrip', 'srt', 'webvtt', 'vtt', 'mov_text'];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Whether an embedded subtitle track is streamed progressively rather than fetched whole.
 * @param {object} track The subtitle MediaStream.
 * @param {object} mediaSource The media source being played.
 * @returns {boolean} Whether to use {@link ProgressiveSubtitleTrack}.
 */
export function canStreamProgressively(track, mediaSource) {
    const codec = (track?.Codec || '').toLowerCase();
    // Not keyed on the source protocol: a Gelato source reaches the client as a virtual file
    // (Protocol File, /stub path) and only the server knows it is remote. For a source really on
    // the server's disk the progressive read is just quicker to show the first lines.
    return track?.DeliveryMethod === 'External'
        && !track.IsExternal
        && (ASS_CODECS.includes(codec) || TEXT_CODECS.includes(codec))
        && !!mediaSource;
}

function parseAssTime(value) {
    const parts = value.trim().split(':');
    if (parts.length !== 3) {
        return NaN;
    }
    return (Number(parts[0]) * 3600) + (Number(parts[1]) * 60) + Number(parts[2]);
}

/**
 * Turns an ASS event line into the TrackEvent the text renderers take.
 * @param {string} line A `Dialogue:` line (Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text).
 * @returns {{StartPositionTicks: number, EndPositionTicks: number, Text: string} | null} The event.
 */
export function assLineToTrackEvent(line) {
    if (!line.startsWith('Dialogue:')) {
        return null;
    }

    const fields = line.slice('Dialogue:'.length).split(',');
    if (fields.length < 10) {
        return null;
    }

    const start = parseAssTime(fields[1]);
    const end = parseAssTime(fields[2]);
    if (Number.isNaN(start) || Number.isNaN(end)) {
        return null;
    }

    // The text may hold commas. Italics, bold and underline from the converted SRT become the
    // tags the renderers show; the remaining override tags are dropped by them.
    const text = fields.slice(9).join(',')
        .replace(/{\\i1}/g, '<i>').replace(/{\\i0?}/g, '</i>')
        .replace(/{\\b1}/g, '<b>').replace(/{\\b0?}/g, '</b>')
        .replace(/{\\u1}/g, '<u>').replace(/{\\u0?}/g, '</u>');

    return {
        StartPositionTicks: Math.round(start * TICKS_PER_SECOND),
        EndPositionTicks: Math.round(end * TICKS_PER_SECOND),
        Text: text
    };
}

/**
 * Turns an ASS event line into the event the ASS renderer adds with createEvent.
 * @param {string} line A `Dialogue:` line.
 * @param {Map<string, number>} styles The renderer's style indexes by name.
 * @param {number} readOrder The event's place in the track.
 * @returns {object | null} The event, with times in milliseconds.
 */
export function assLineToRendererEvent(line, styles, readOrder) {
    if (!line.startsWith('Dialogue:')) {
        return null;
    }

    const fields = line.slice('Dialogue:'.length).split(',');
    if (fields.length < 10) {
        return null;
    }

    const start = parseAssTime(fields[1]);
    const end = parseAssTime(fields[2]);
    if (Number.isNaN(start) || Number.isNaN(end)) {
        return null;
    }

    const styleName = fields[3].trim();
    const style = styles.get(styleName) ?? styles.get(styleName.replace(/^\*/, '')) ?? styles.get('Default') ?? 0;

    return {
        Start: Math.round(start * 1000),
        Duration: Math.max(0, Math.round((end - start) * 1000)),
        ReadOrder: readOrder,
        Layer: Number(fields[0].trim()) || 0,
        Style: style,
        Name: fields[4],
        MarginL: Number(fields[5]) || 0,
        MarginR: Number(fields[6]) || 0,
        MarginV: Number(fields[7]) || 0,
        Effect: fields[8],
        Text: fields.slice(9).join(',')
    };
}

export class ProgressiveSubtitleTrack {
    #apiClient;
    #itemId;
    #mediaSourceId;
    #index;
    #videoElement;
    #getPositionTicks;
    #onEvents;
    #onComplete;
    #onSeeked = null;

    #header = '';
    #seen = new Set();
    #wholeTrack = false;

    // The read being followed.
    #session = null;
    #startTicks = 0;
    #next = 0;
    #complete = false;
    #coveredTicks = 0;
    #generation = 0;

    #attached = false;
    #disposed = false;

    /**
     * @param {object} options Options.
     * @param {object} options.apiClient The API client of the item's server.
     * @param {string} options.itemId The item id.
     * @param {string} options.mediaSourceId The media source id.
     * @param {number} options.index The subtitle stream index.
     * @param {HTMLVideoElement} options.videoElement The video element.
     * @param {() => number} options.getPositionTicks The current playback position in ticks.
     * @param {(lines: string[], header: string) => void} options.onEvents Gets the event lines not
     *     seen before, as they arrive, with the script header.
     * @param {(startTicks: number) => void} [options.onComplete] Called once a read reaches the end of
     *     the file, with where it began: one that began mid-file misses the earlier lines.
     */
    constructor({ apiClient, itemId, mediaSourceId, index, videoElement, getPositionTicks, onEvents, onComplete }) {
        this.#apiClient = apiClient;
        this.#itemId = itemId;
        this.#mediaSourceId = mediaSourceId;
        this.#index = index;
        this.#videoElement = videoElement;
        this.#getPositionTicks = getPositionTicks;
        this.#onEvents = onEvents;
        this.#onComplete = onComplete;
    }

    get header() {
        return this.#header;
    }

    /**
     * Starts reading at a position.
     * @param {number} positionTicks The playback position.
     * @returns {Promise<{header: string, lines: string[]}|null>} The first events, or null to use the
     *     regular track.
     */
    async start(positionTicks) {
        const reply = await this.#request(Math.max(0, positionTicks - START_MARGIN_TICKS), null, 0, FIRST_WAIT_MS);
        if (this.#disposed || !reply || reply.Failed || !reply.Header) {
            return null;
        }

        const lines = this.#follow(reply);
        return { header: this.#header, lines };
    }

    /** Starts following the read: new events go to `onEvents` from now on. */
    attach() {
        if (this.#disposed || this.#attached) {
            return;
        }

        this.#attached = true;
        this.#onSeeked = () => this.#handleSeek();
        this.#videoElement.addEventListener('seeked', this.#onSeeked);
        this.#poll(this.#generation);
    }

    /** The renderer has the whole track now (fetched the regular way): no more reads. */
    markWholeTrack() {
        this.#wholeTrack = true;
        this.#generation++;
    }

    dispose() {
        this.#disposed = true;
        this.#generation++;
        if (this.#onSeeked) {
            this.#videoElement.removeEventListener('seeked', this.#onSeeked);
            this.#onSeeked = null;
        }
    }

    #request(startTicks, session, since, waitMs) {
        const params = {
            startPositionTicks: Math.round(startTicks),
            since,
            waitMs
        };
        if (session) {
            params.session = session;
        }

        const url = this.#apiClient.getUrl(`Videos/${this.#itemId}/${this.#mediaSourceId}/Subtitles/${this.#index}/Progressive`, params);
        return this.#apiClient.getJSON(url).catch(err => {
            console.warn('[ProgressiveSubtitles] request failed', err);
            return null;
        });
    }

    /** Follows a new read, keeping the events of the previous ones; returns its new lines. */
    #follow(reply) {
        this.#session = reply.Session;
        this.#startTicks = reply.StartPositionTicks;
        this.#next = reply.Next;
        this.#complete = reply.Complete;
        this.#coveredTicks = reply.CoveredTicks;
        if (reply.Header) {
            this.#header = reply.Header;
        }
        return this.#unseen(reply.Events);
    }

    #unseen(events) {
        const fresh = [];
        for (const line of events) {
            if (!this.#seen.has(line)) {
                this.#seen.add(line);
                fresh.push(line);
            }
        }
        return fresh;
    }

    #deliver(lines) {
        if (lines.length && !this.#disposed && !this.#wholeTrack) {
            this.#onEvents(lines, this.#header);
        }
    }

    async #poll(generation) {
        while (!this.#disposed && generation === this.#generation && !this.#complete) {
            const reply = await this.#request(this.#startTicks, this.#session, this.#next, POLL_WAIT_MS);
            if (this.#disposed || generation !== this.#generation) {
                return;
            }

            if (!reply) {
                await delay(RETRY_DELAY_MS);
                continue;
            }

            if (reply.Session !== this.#session) {
                // The server dropped the read (restart, or it went idle): follow the new one from
                // its first event; the events already here stay.
                const fresh = await this.#request(this.#startTicks, null, 0, POLL_WAIT_MS);
                if (this.#disposed || generation !== this.#generation) {
                    return;
                }
                if (fresh && !fresh.Failed) {
                    this.#deliver(this.#follow(fresh));
                }
                continue;
            }

            this.#next = reply.Next;
            this.#coveredTicks = reply.CoveredTicks;
            this.#complete = reply.Complete || reply.Failed;
            this.#deliver(this.#unseen(reply.Events));
        }

        if (!this.#disposed && generation === this.#generation && this.#complete) {
            this.#onComplete?.(this.#startTicks);
        }
    }

    #handleSeek() {
        if (this.#disposed || this.#wholeTrack) {
            return;
        }

        const position = this.#getPositionTicks();
        const beforeRead = position < this.#startTicks;
        const pastRead = !this.#complete && position > this.#coveredTicks + SEEK_AHEAD_TICKS;
        if (beforeRead || pastRead) {
            this.#restart(position);
        }
    }

    async #restart(positionTicks) {
        const generation = ++this.#generation;
        const reply = await this.#request(Math.max(0, positionTicks - START_MARGIN_TICKS), null, 0, FIRST_WAIT_MS);
        if (this.#disposed || generation !== this.#generation || !reply || reply.Failed) {
            return;
        }

        this.#deliver(this.#follow(reply));
        this.#poll(generation);
    }
}
