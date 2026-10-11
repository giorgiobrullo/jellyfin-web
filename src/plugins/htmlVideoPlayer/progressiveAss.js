/**
 * Streams an embedded ASS/SSA track of a remote source while the server reads it.
 *
 * The events of a Matroska text track are spread over the whole file, so a full extraction of a
 * remote source has to download all of it before the server returns a single line (40-60 s for a
 * 2-3 GB episode). The server's progressive endpoint reads from the playback position and hands
 * out events as it finds them, far ahead of playback, so the renderer starts within seconds and
 * gets the growing track every few seconds until the server reaches the end of the file.
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
// setTrack() re-parses the track and drops the renderer's pre-rendered frames: not on every batch.
const UPDATE_INTERVAL_MS = 3000;
// Start a little before the position, for the line already on screen.
const START_MARGIN_TICKS = 5 * TICKS_PER_SECOND;
// A seek this far past what the current read has reached starts a new read from there.
const SEEK_AHEAD_TICKS = 30 * TICKS_PER_SECOND;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Whether a subtitle track is streamed progressively rather than fetched whole.
 * @param {object} track The subtitle MediaStream.
 * @param {object} mediaSource The media source being played.
 * @returns {boolean} Whether to use {@link ProgressiveAssTrack}.
 */
export function canStreamProgressively(track, mediaSource) {
    const codec = (track?.Codec || '').toLowerCase();
    // Not keyed on the source protocol: a Gelato source reaches the client as a virtual file
    // (Protocol File, /stub path) and only the server knows it is remote. For a source really on
    // the server's disk the progressive read is just quicker to show the first lines.
    return track?.DeliveryMethod === 'External'
        && !track.IsExternal
        && (codec === 'ass' || codec === 'ssa')
        && !!mediaSource;
}

export class ProgressiveAssTrack {
    #apiClient;
    #itemId;
    #mediaSourceId;
    #index;
    #fullTrackUrl;
    #videoElement;
    #getPositionTicks;
    #renderer = null;
    #onSeeked = null;

    #header = '';
    #events = [];
    #seen = new Set();
    #fullTrackLoaded = false;

    // The read being followed.
    #session = null;
    #startTicks = 0;
    #next = 0;
    #complete = false;
    #coveredTicks = 0;
    #generation = 0;

    #dirty = false;
    #lastUpdate = 0;
    #disposed = false;

    /**
     * @param {object} options Options.
     * @param {object} options.apiClient The API client of the item's server.
     * @param {string} options.itemId The item id.
     * @param {string} options.mediaSourceId The media source id.
     * @param {number} options.index The subtitle stream index.
     * @param {string} options.fullTrackUrl The regular URL of the whole track.
     * @param {HTMLVideoElement} options.videoElement The video element.
     * @param {() => number} options.getPositionTicks The current playback position in ticks.
     */
    constructor({ apiClient, itemId, mediaSourceId, index, fullTrackUrl, videoElement, getPositionTicks }) {
        this.#apiClient = apiClient;
        this.#itemId = itemId;
        this.#mediaSourceId = mediaSourceId;
        this.#index = index;
        this.#fullTrackUrl = fullTrackUrl;
        this.#videoElement = videoElement;
        this.#getPositionTicks = getPositionTicks;
    }

    /**
     * Starts reading at a position.
     * @param {number} positionTicks The playback position.
     * @returns {Promise<string|null>} The first content for the renderer, or null to use the regular track.
     */
    async start(positionTicks) {
        const reply = await this.#request(Math.max(0, positionTicks - START_MARGIN_TICKS), null, 0, FIRST_WAIT_MS);
        if (this.#disposed || !reply || reply.Failed || !reply.Header) {
            return null;
        }

        this.#follow(reply);
        this.#dirty = false;
        return this.#content();
    }

    /**
     * Hands the renderer over: from now on it gets the track as it grows.
     * @param {object} renderer The SubtitlesOctopus instance.
     */
    attach(renderer) {
        if (this.#disposed) {
            return;
        }

        this.#renderer = renderer;
        this.#lastUpdate = Date.now();
        this.#onSeeked = () => this.#handleSeek();
        this.#videoElement.addEventListener('seeked', this.#onSeeked);
        this.#poll(this.#generation);
    }

    dispose() {
        this.#disposed = true;
        this.#generation++;
        if (this.#onSeeked) {
            this.#videoElement.removeEventListener('seeked', this.#onSeeked);
            this.#onSeeked = null;
        }
        this.#renderer = null;
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
            console.warn('[ProgressiveAss] request failed', err);
            return null;
        });
    }

    /** Follows a new read, keeping the events of the previous ones. */
    #follow(reply) {
        this.#session = reply.Session;
        this.#startTicks = reply.StartPositionTicks;
        this.#next = reply.Next;
        this.#complete = reply.Complete;
        this.#coveredTicks = reply.CoveredTicks;
        if (reply.Header) {
            this.#header = reply.Header;
        }
        this.#add(reply.Events);
    }

    #add(events) {
        for (const line of events) {
            if (!this.#seen.has(line)) {
                this.#seen.add(line);
                this.#events.push(line);
                this.#dirty = true;
            }
        }
    }

    #content() {
        return this.#header + this.#events.join('\n') + '\n';
    }

    #update(force) {
        if (!this.#renderer || !this.#dirty || this.#fullTrackLoaded) {
            return;
        }

        if (!force && Date.now() - this.#lastUpdate < UPDATE_INTERVAL_MS) {
            return;
        }

        this.#renderer.setTrack(this.#content());
        this.#dirty = false;
        this.#lastUpdate = Date.now();
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
                    this.#follow(fresh);
                }
                this.#update(false);
                continue;
            }

            this.#add(reply.Events);
            this.#next = reply.Next;
            this.#coveredTicks = reply.CoveredTicks;
            this.#complete = reply.Complete || reply.Failed;
            this.#update(this.#complete);
        }

        if (!this.#disposed && generation === this.#generation && this.#complete && this.#startTicks > 0) {
            // The read began after the start of the file: the regular track has the earlier lines.
            this.#loadFullTrack(generation);
        }
    }

    async #loadFullTrack(generation) {
        try {
            const response = await fetch(this.#fullTrackUrl);
            if (!response.ok) {
                return;
            }
            const text = await response.text();
            if (this.#disposed || generation !== this.#generation || !this.#renderer) {
                return;
            }
            this.#renderer.setTrack(text);
            this.#fullTrackLoaded = true;
        } catch (err) {
            console.warn('[ProgressiveAss] could not load the whole track', err);
        }
    }

    #handleSeek() {
        if (this.#disposed || this.#fullTrackLoaded) {
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

        this.#follow(reply);
        this.#update(true);
        this.#poll(generation);
    }
}
