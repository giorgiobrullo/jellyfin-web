/**
 * Version picker for titles with many sources (Gelato streams), in the spirit of AnimeBytes'
 * torrent lists: the versions grouped by resolution, one line each with the release group first
 * and its properties separated by pipes (source, container, codec, bit depth, HDR, audio,
 * languages, subtitles), and size, rating and cache state on the right.
 *
 * Languages answer "is mine there?": the line names the ones that matter to the viewer (their
 * audio and subtitle preferences, the interface language, the title's original language, English
 * for subtitles) and counts the rest, which the tooltip lists.
 *
 * The technical properties come from the source's media streams; the addon's formatted name only
 * gives what the streams cannot (release type, release group, rating, cache state) and stands in for the
 * streams when the source has not been probed. The native select stays the source of truth: a
 * pick sets its value and fires its change event, so the rest of the page works unchanged.
 */

import escapeHtml from 'escape-html';

import globalize from 'lib/globalize';
import { canPlayHevc } from 'scripts/browserDeviceProfile';

import './versionPicker.scss';

const VIDEO_CODECS = { hevc: 'HEVC', h265: 'HEVC', h264: 'AVC', avc: 'AVC', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', vc1: 'VC-1' };
const AUDIO_CODECS = { truehd: 'TrueHD', eac3: 'DD+', ac3: 'DD', dts: 'DTS', flac: 'FLAC', aac: 'AAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis' };
const RANGES = {
    DOVIWithHDR10: 'DV + HDR10',
    DOVIWithHDR10Plus: 'DV + HDR10+',
    DOVIWithHLG: 'DV + HLG',
    DOVIWithSDR: 'DV',
    DOVI: 'DV',
    DOVIInvalid: 'DV',
    HDR10Plus: 'HDR10+',
    HDR10: 'HDR10',
    HLG: 'HLG'
};
const RELEASE_TYPES = [
    [/remux/i, 'Remux'],
    [/blu-?ray|bdrip|brrip/i, 'Blu-ray'],
    [/web-?dl/i, 'WEB-DL'],
    [/web-?rip/i, 'WEBRip'],
    [/hdtv/i, 'HDTV'],
    [/dvd/i, 'DVD']
];

// ISO 639-2 has two codes for some languages; streams use either.
const LANGUAGE_ALIASES = { fre: 'fra', ger: 'deu', chi: 'zho', dut: 'nld', cze: 'ces', slo: 'slk', rum: 'ron', gre: 'ell', per: 'fas' };
// The interface language (ISO 639-1) as the streams name it.
const INTERFACE_LANGUAGES = {
    ar: 'ara', cs: 'ces', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', fi: 'fin', fr: 'fra', hu: 'hun', it: 'ita',
    ja: 'jpn', ko: 'kor', nb: 'nor', nl: 'nld', no: 'nor', pl: 'pol', pt: 'por', ru: 'rus', sv: 'swe', tr: 'tur', uk: 'ukr', zh: 'zho'
};

const SMALL_CAPS = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ';

let hevcSupport;

function browserPlaysHevc() {
    if (hevcSupport === undefined) {
        try {
            hevcSupport = !!canPlayHevc(document.createElement('video'), {});
        } catch {
            hevcSupport = true;
        }
    }
    return hevcSupport;
}

function channelLayout(channels) {
    const layouts = { 1: '1.0', 2: '2.0', 3: '2.1', 6: '5.1', 7: '6.1', 8: '7.1' };
    if (layouts[channels]) {
        return layouts[channels];
    }
    return channels ? channels + 'ch' : '';
}

function formatSize(bytes) {
    if (!bytes) {
        return '';
    }
    const gb = bytes / (1024 ** 3);
    if (gb < 1) {
        return `${Math.round(bytes / (1024 ** 2))} MB`;
    }
    const digits = gb >= 10 ? 1 : 2;
    return `${gb.toFixed(digits)} GB`;
}

// Not probed: the addon's name has "❖ 2.5 / 62.9 GB · …", the file then the whole pack.
function sizeFromName(name) {
    const sizes = (/❖([^\n·]+)/.exec(name)?.[1] || '').trim();
    const unit = sizes.slice(-2);
    const file = sizes.split('/')[0].trim();
    if (unit !== 'GB' && unit !== 'MB') {
        return '';
    }
    return file.endsWith(unit) ? file : file + ' ' + unit;
}

function formatBitrate(bitsPerSecond) {
    if (!bitsPerSecond) {
        return '';
    }
    const digits = bitsPerSecond >= 1e7 ? 0 : 1;
    return `${(bitsPerSecond / 1e6).toFixed(digits)} Mbps`;
}

function resolutionOf(video, name) {
    const height = video?.Height || 0;
    const width = video?.Width || 0;
    if (width >= 3200 || height >= 2000) return '2160p';
    if (width >= 2200 || height >= 1300) return '1440p';
    if (width >= 1700 || height >= 1000) return '1080p';
    if (width >= 1100 || height >= 700) return '720p';
    if (height) return `${height}p`;
    if (/\b(4K|2160p|UHD)\b/i.test(name)) return '2160p';
    const match = /\b(1440|1080|720|576|480)p\b/i.exec(name);
    return match ? `${match[1]}p` : '';
}

function audioLabel(audio) {
    const codec = (audio.Codec || '').toLowerCase();
    let label = codec.startsWith('pcm') ? 'PCM' : (AUDIO_CODECS[codec] || codec.toUpperCase());
    const profile = audio.Profile || '';
    if (codec === 'dts' && /MA|HD/.test(profile)) {
        label = 'DTS-HD MA';
    } else if (codec === 'dts' && /X/.test(profile)) {
        label = 'DTS:X';
    }
    if (/atmos/i.test(profile) || /atmos/i.test(audio.DisplayTitle || '')) {
        label += ' Atmos';
    }
    const layout = channelLayout(audio.Channels);
    return layout ? label + ' ' + layout : label;
}

function languageOf(stream) {
    const language = (stream.Language || '').toLowerCase();
    return language === 'und' ? '' : (LANGUAGE_ALIASES[language] || language);
}

function languagesOf(streams) {
    return [...new Set(streams.map(languageOf).filter(Boolean))];
}

/**
 * The languages that matter to the viewer.
 * @param {object} [user] The signed-in user.
 * @param {object[]} mediaSources The title's versions.
 * @returns {{audio: Set<string>, subtitles: Set<string>}} Their ISO 639-2 codes.
 */
export function relevantLanguages(user, mediaSources) {
    const config = user?.Configuration || {};
    const preferred = [
        config.AudioLanguagePreference,
        config.SubtitleLanguagePreference,
        INTERFACE_LANGUAGES[(globalize.getCurrentLocale() || '').split('-')[0]]
    ].map(code => languageOf({ Language: code })).filter(Boolean);

    // The original language is the one most versions have: dubs are the exceptions.
    const counts = new Map();
    for (const source of mediaSources) {
        for (const language of languagesOf((source.MediaStreams || []).filter(s => s.Type === 'Audio'))) {
            counts.set(language, (counts.get(language) || 0) + 1);
        }
    }
    const original = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    return {
        audio: new Set([...preferred, original].filter(Boolean)),
        subtitles: new Set([...preferred, 'eng'])
    };
}

// The languages worth naming (the main one first, then the relevant ones in the stream order),
// with the others counted.
function languageSummary(languages, relevant, main) {
    const shown = languages.filter(l => l === main || relevant.has(l));
    shown.sort((a, b) => (b === main) - (a === main));
    const others = languages.length - shown.length;
    const text = shown.map(l => l.toUpperCase()).join(' · ');
    return { text: others ? (text + ' +' + others).trim() : text, title: languages.map(l => l.toUpperCase()).join(' · ') };
}

// The release type the addon's name puts in angle brackets (〈Remux〉).
function bracketed(name) {
    const start = name.indexOf('〈');
    const end = start < 0 ? -1 : name.indexOf('〉', start + 1);
    return end > start ? name.slice(start + 1, end) : '';
}

/**
 * Not probed: the addon's name has the languages it matched, "✓ ᴇɴ · ᴊᴀ · sᴜʙ (ᴇɴ) » …", as
 * streams to describe in their place.
 */
function streamsFromName(name) {
    const line = (/✓([^\n»]+)/.exec(name)?.[1] || '').trim();
    const plain = [...line].map(c => {
        const index = SMALL_CAPS.indexOf(c);
        return index < 0 ? c : String.fromCharCode(97 + index);
    }).join('');
    const toStream = (Type, code) => ({ Type, Language: INTERFACE_LANGUAGES[code.trim()] || code.trim() });
    const [spoken, subtitles] = plain.split('sub');
    return {
        audios: spoken.split('·').map(c => c.trim()).filter(Boolean).map(c => toStream('Audio', c)),
        subtitles: (subtitles || '').replace(/[()]/g, '').split('·').filter(c => c.trim()).map(c => toStream('Subtitle', c))
    };
}

function audioLanguages(audios, relevant, main) {
    const languages = languagesOf(audios);
    if (languages.length === 2 && languages.includes('jpn') && languages.includes('eng')) {
        return { text: 'Dual Audio', variant: 'dual', title: 'JPN · ENG' };
    }
    return languageSummary(languages, relevant, main || languages[0]);
}

function subtitleLanguages(subtitles, relevant) {
    // Forced tracks only carry signs and foreign lines.
    const full = subtitles.filter(s => !s.IsForced);
    const languages = languagesOf(full);
    if (!full.length) {
        return {};
    }
    const { text, title } = languageSummary(languages, relevant, null);
    if (text && !text.startsWith('+')) {
        return { text: 'Sub ' + text, title };
    }
    // None of the viewer's languages.
    return { text: full.length + ' sub', variant: 'none', title };
}

/**
 * Reads what the picker shows from a media source.
 * @param {object} source A MediaSourceInfo.
 * @param {{audio: Set<string>, subtitles: Set<string>}} [languages] The languages that matter, from {@link relevantLanguages}.
 * @returns {object} The description.
 */
export function describeSource(source, languages = { audio: new Set(), subtitles: new Set(['eng']) }) {
    const name = source.Name || '';
    const streams = source.MediaStreams || [];
    const video = streams.find(s => s.Type === 'Video');
    const named = streams.length ? null : streamsFromName(name);
    const audios = named?.audios || streams.filter(s => s.Type === 'Audio');
    const subtitles = named?.subtitles || streams.filter(s => s.Type === 'Subtitle');

    // Typed tokens, coloured by kind and value (see versionPicker.scss), in AnimeBytes' order
    // after the group: release type | container | codec | resolution | HDR | audio | languages |
    // subtitles.
    const tokens = [];
    const add = (kind, text, variant, title) => {
        if (text) tokens.push({ kind, text, variant: variant || '', title: title || '' });
    };

    // SeaDex first: the anime release the community rates best (a title can have several) or
    // an alternative to it. The addon's name says "best release" for the first and only names
    // SeaDex as the origin for the second.
    if (/ʙᴇsᴛ ʀᴇʟᴇᴀsᴇ|best release/i.test(name)) {
        add('seadex', 'SeaDex Best', 'best');
    } else if (/seadex/i.test(name)) {
        add('seadex', 'SeaDex Alt', 'alt');
    }

    // The addon's origin line reads "[TB] STorz · FraMeSToR": debrid service and addon, which do
    // not help pick, then the release group when it knows one.
    add('group', (/⛉([^\n]+)/.exec(name)?.[1] || '').split('·')[1]?.trim());

    const releaseType = (bracketed(name) || RELEASE_TYPES.find(([re]) => re.test(name))?.[1] || '').trim();
    add('type', releaseType, releaseType.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (source.Container) add('container', source.Container.split(',')[0].toUpperCase());

    const resolution = resolutionOf(video, name);
    let isHevc = false;
    if (video) {
        const codec = (video.Codec || '').toLowerCase();
        isHevc = codec === 'hevc' || codec === 'h265';
        const codecLabel = VIDEO_CODECS[codec] || codec.toUpperCase();
        const bits = video.BitDepth && video.BitDepth > 8 ? ' ' + video.BitDepth + '-bit' : '';
        add('codec', codecLabel + bits, codecLabel.toLowerCase().replace(/[^a-z0-9]/g, ''));
        add('res', resolution, resolution);
        const range = RANGES[video.VideoRangeType];
        add('hdr', range, range?.startsWith('DV') ? 'dv' : 'hdr');
    } else {
        // Not probed: the addon's formatted name lists the codec and the HDR formats.
        // The audio can follow on the same line ("▣ HEVC ♬ OPUS ♯ 2.0").
        const videoLine = (/▣([^\n]+)/.exec(name)?.[1] || '').split('♬')[0];
        const pieces = videoLine.split(/[✦·]/).map(p => p.trim()).filter(Boolean);
        isHevc = /HEVC|H\.?265|x265/i.test(videoLine);
        const codecLabel = pieces.shift() || '';
        add('codec', codecLabel, codecLabel.toLowerCase().replace(/[^a-z0-9]/g, ''));
        add('res', resolution, resolution);
        for (const piece of pieces) add('hdr', piece, /(^DV)|(dolby)/i.test(piece) ? 'dv' : 'hdr');
    }

    const defaultAudio = audios.find(a => a.IsDefault) || audios[0];
    if (defaultAudio && !named) {
        const label = audioLabel(defaultAudio);
        const lossless = /TrueHD|DTS-HD|DTS:X|FLAC|PCM/.test(label);
        add('audio', label, lossless ? 'lossless' : 'lossy');
    } else {
        const audioLine = /♬([^\n]+)/.exec(name)?.[1];
        const label = audioLine ? audioLine.replace(/♯/g, '·').replace(/\s+/g, ' ').trim() : '';
        add('audio', label, /TrueHD|DTS-HD|FLAC|PCM/.test(label) ? 'lossless' : 'lossy');
    }
    const spoken = audioLanguages(audios, languages.audio, defaultAudio && languageOf(defaultAudio));
    add('lang', spoken.text, spoken.variant, spoken.title);
    const subs = subtitleLanguages(subtitles, languages.subtitles);
    add('subs', subs.text, subs.variant, subs.title);

    // AIOStreams' score of the version against the others for the title, 0-100 drawn as five
    // stars with halves (⯪).
    const stars = (name.match(/★/g) || []).length + ((name.match(/⯪/g) || []).length / 2);
    const cached = /⚡/.test(name);

    return {
        resolution,
        tokens,
        size: formatSize(source.Size) || sizeFromName(name),
        bitrate: formatBitrate(source.Bitrate),
        stars,
        cached,
        mayNotPlay: isHevc && !browserPlaysHevc()
    };
}

function lineHtml(description) {
    // Spaces around the separators: the line can wrap there on narrow screens.
    return description.tokens.map(({ kind, text, variant, title }) => {
        const variantClass = variant ? ' vpTok-' + kind + '-' + variant : '';
        const titleAttribute = title && title !== text ? ' title="' + escapeHtml(title) + '"' : '';
        return '<span class="vpTok vpTok-' + kind + variantClass + '"' + titleAttribute + '>' + escapeHtml(text) + '</span>';
    }).join(' <span class="versionPickerSep">|</span> ');
}

function starsHtml(stars) {
    const full = Math.floor(stars);
    const title = escapeHtml(globalize.translate('VersionScore', stars));
    return `<span class="versionPickerStars" title="${title}">${'★'.repeat(full)}${stars > full ? '⯪' : ''}</span>`;
}

function metaHtml(description) {
    const meta = [];
    // The size alone: the versions of a title run as long, so the bitrate only says it again.
    if (description.size) meta.push(`<span class="versionPickerSize" title="${escapeHtml(description.bitrate)}">${escapeHtml(description.size)}</span>`);
    if (description.stars) meta.push(starsHtml(description.stars));
    if (description.cached) meta.push(`<span class="versionPickerCached" title="${escapeHtml(globalize.translate('VersionCached'))}">⚡</span>`);
    if (description.mayNotPlay) meta.push(`<span class="versionPickerWarn" title="${escapeHtml(globalize.translate('VersionMayNotPlay'))}">⚠</span>`);
    return meta.join('');
}

function rowHtml(source, description, selectedId) {
    const selectedClass = source.Id === selectedId ? ' versionPickerSelected' : '';
    return '<button type="button" class="versionPickerRow' + selectedClass + '" data-id="' + escapeHtml(source.Id) + '">'
        + '<span class="versionPickerLine">' + lineHtml(description) + '</span>'
        + '<span class="versionPickerMeta">' + metaHtml(description) + '</span>'
        + '</button>';
}

function groupHtml(group, entries, selectedId) {
    // A section per group: its header sticks while its rows scroll, and the next one takes its place.
    return '<div class="versionPickerSection">'
        + '<div class="versionPickerGroup">' + escapeHtml(group) + ' <span class="versionPickerDim">' + entries.length + '</span></div>'
        + entries.map(({ source, description }) => rowHtml(source, description, selectedId)).join('')
        + '</div>';
}

function groupOf(description) {
    return description.resolution || globalize.translate('Other');
}

function close(picker) {
    picker.classList.remove('versionPickerOpen');
    picker.querySelector('.versionPickerCurrent')?.setAttribute('aria-expanded', 'false');
}

/**
 * Draws the picker for a source select, or the loading state while the versions are fetched.
 * @param {HTMLElement} container The select's container (.selectSourceContainer).
 * @param {HTMLSelectElement} select The source select.
 * @param {object[]|null} mediaSources The versions, or null while they are being fetched.
 * @param {object} [user] The signed-in user, for their language preferences.
 */
export function renderVersionPicker(container, select, mediaSources, user) {
    let picker = container.querySelector('.versionPicker');
    if (!picker) {
        picker = document.createElement('div');
        picker.className = 'versionPicker';
        container.appendChild(picker);

        picker.addEventListener('click', e => {
            const row = e.target.closest('.versionPickerRow');
            if (row) {
                e.preventDefault();
                if (select.value !== row.dataset.id) {
                    select.value = row.dataset.id;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                picker._redraw?.();
                close(picker);
                picker.querySelector('.versionPickerCurrent')?.focus();
                return;
            }
            if (e.target.closest('.versionPickerCurrent') && !picker.classList.contains('versionPickerLoading')) {
                e.preventDefault();
                const open = !picker.classList.contains('versionPickerOpen');
                picker.classList.toggle('versionPickerOpen', open);
                e.target.closest('.versionPickerCurrent').setAttribute('aria-expanded', String(open));
                if (open) {
                    picker.querySelector('.versionPickerRow.versionPickerSelected')?.scrollIntoView({ block: 'nearest' });
                }
            }
        });
        picker.addEventListener('keydown', e => {
            if (e.key === 'Escape' && picker.classList.contains('versionPickerOpen')) {
                e.stopPropagation();
                close(picker);
                picker.querySelector('.versionPickerCurrent')?.focus();
            }
        });
        document.addEventListener('click', e => {
            if (!picker.contains(e.target)) {
                close(picker);
            }
        });
    }

    container.classList.add('versionPickerActive');

    if (!mediaSources) {
        picker._redraw = null;
        picker.classList.add('versionPickerLoading');
        close(picker);
        // The shape of a version's line, shimmering, with a spinner where the count goes; as tall as
        // the line it stands for.
        const pills = widths => widths.map(width => `<span class="versionPickerSkeleton" style="width:${width}em"></span>`).join('');
        const label = escapeHtml(globalize.translate('LoadingVersions'));
        picker.innerHTML = `<button type="button" class="versionPickerCurrent" disabled aria-label="${label}" title="${label}">
            <span class="versionPickerLine versionPickerSkeletonLine">${pills([5, 3.5, 2.5, 5.5, 3, 4.5, 6, 2.5, 5])}</span>
            <span class="versionPickerMeta">${pills([3.5, 4])}</span>
            <span class="versionPickerSpinner" aria-hidden="true"></span>
            <span class="material-icons versionPickerChevron versionPickerDim" aria-hidden="true">expand_more</span>
        </button>`;
        return;
    }

    picker.classList.remove('versionPickerLoading');
    const languages = relevantLanguages(user, mediaSources);
    const described = mediaSources.map(source => ({ source, description: describeSource(source, languages) }));

    picker._redraw = () => {
        const selectedId = select.value;
        const selected = described.find(d => d.source.Id === selectedId) || described[0];

        const groups = new Map();
        for (const entry of described) {
            const key = groupOf(entry.description);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
        }

        const rows = [...groups.entries()].map(([group, entries]) => groupHtml(group, entries, selected.source.Id)).join('');

        const expanded = String(picker.classList.contains('versionPickerOpen'));
        picker.innerHTML = '<button type="button" class="versionPickerCurrent" aria-haspopup="listbox" aria-expanded="' + expanded + '">'
            + '<span class="versionPickerLine">' + lineHtml(selected.description) + '</span>'
            + '<span class="versionPickerMeta">' + metaHtml(selected.description) + '</span>'
            + '<span class="versionPickerCount">' + described.length + '</span>'
            + '<span class="material-icons versionPickerChevron" aria-hidden="true">expand_more</span>'
            + '</button>'
            + '<div class="versionPickerPanel" role="listbox">' + rows + '</div>';
    };
    picker._redraw();
}

/**
 * Removes the picker and gives the select its place back.
 * @param {HTMLElement} container The select's container.
 */
export function removeVersionPicker(container) {
    container.classList.remove('versionPickerActive');
    container.querySelector('.versionPicker')?.remove();
}
