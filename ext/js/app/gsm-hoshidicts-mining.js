/*
 * Copyright (C) 2025-2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {AnkiNoteBuilder} from '../data/anki-note-builder.js';
import {getDynamicTemplates} from '../data/anki-template-util.js';
import {parseJson} from '../core/json.js';
import {TemplateRendererProxy} from '../templates/template-renderer-proxy.js';

export const HOSHIDICTS_MAX_BRIDGE_PAYLOAD_BYTES = 256 * 1024;

export const HOSHIDICTS_MAX_GLOSSARIES = 64;

export const HOSHIDICTS_MAX_TRACE_STEPS = 32;

const MAX_TEXT_LENGTH = 128 * 1024;
const MAX_TERM_TEXT_LENGTH = 4096;
const MAX_TAG_TEXT_LENGTH = 4096;
const IGNORED_STRUCTURED_TAGS = new Set([
    'audio',
    'button',
    'canvas',
    'iframe',
    'img',
    'input',
    'script',
    'source',
    'style',
    'svg',
    'video',
]);
const BLOCK_STRUCTURED_TAGS = new Set([
    'br',
    'div',
    'li',
    'ol',
    'p',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
]);

/**
 * @typedef {{
 *   operation: 'mine',
 *   result: ReturnType<typeof validateResult>,
 *   sentence: string,
 *   matchOffset: number,
 * }} HoshidictsMineRequest
 */

/**
 * @typedef {Pick<
 *   import('../comm/api.js').API,
 *   'addAnkiNote'|
 *   'forceSync'|
 *   'getAnkiNoteInfo'|
 *   'getDefaultAnkiFieldTemplates'|
 *   'getDictionaryInfo'|
 *   'injectAnkiNoteMedia'|
 *   'isAnkiConnected'|
 *   'optionsGet'|
 *   'parseText'|
 *   'suspendAnkiCardsForNote'
 * >} HoshidictsMiningApi
 */

/** Error returned for invalid or unsupported Hoshidicts mining requests. */
export class HoshidictsMiningError extends Error {
    /**
     * @param {string} message
     * @param {number} [statusCode]
     */
    constructor(message, statusCode = 400) {
        super(message);
        /**
         *
         */
        this.name = 'HoshidictsMiningError';
        /** @type {number} */
        this.statusCode = statusCode;
    }
}

/**
 * @param {unknown} value
 * @returns {value is import('core').UnknownObject}
 */
function isObjectNotArray(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {import('core').UnknownObject} value
 * @param {string[]} required
 * @param {string[]} optional
 * @param {string} name
 * @throws {HoshidictsMiningError}
 */
function assertObjectKeys(value, required, optional, name) {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new HoshidictsMiningError(`Invalid ${name} field: ${key}`);
        }
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new HoshidictsMiningError(`Missing ${name} field: ${key}`);
        }
    }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxLength
 * @param {boolean} [allowEmpty]
 * @returns {string}
 * @throws {HoshidictsMiningError}
 */
function validateString(value, name, maxLength, allowEmpty = true) {
    if (
        typeof value !== 'string' ||
        value.length > maxLength ||
        (!allowEmpty && value.length === 0) ||
        value.includes('\u0000')
    ) {
        throw new HoshidictsMiningError(`Invalid ${name}`);
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} minimum
 * @param {number} maximum
 * @returns {number}
 * @throws {HoshidictsMiningError}
 */
function validateInteger(value, name, minimum, maximum) {
    if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        throw new HoshidictsMiningError(`Invalid ${name}`);
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 * @throws {HoshidictsMiningError}
 */
function validateFiniteNumber(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new HoshidictsMiningError(`Invalid ${name}`);
    }
    return value;
}

/**
 * @param {?Document} [documentRef]
 * @returns {boolean}
 */
export function isHoshidictsReaderEnabled(documentRef = null) {
    documentRef ??= typeof document === 'object' ? document : null;
    return documentRef?.documentElement?.dataset?.gsmHoshidictsEnabled === 'true';
}

/**
 * @param {MessageEvent|{source?: unknown}} event
 * @param {Window} [windowRef]
 * @param {Document} [documentRef]
 * @returns {boolean}
 */
export function isHoshidictsMiningAuthorized(
    event,
    windowRef = window,
    documentRef = document,
) {
    const {location} = windowRef;
    const pathname = location.pathname.replaceAll('\\', '/');
    return (
        event?.source === windowRef &&
        windowRef.top === windowRef &&
        location.protocol === 'file:' &&
        /(?:^|\/)GSM_Overlay\/index\.html$/u.test(pathname) &&
        documentRef.documentElement.dataset.gsmHoshidictsEnabled === 'true'
    );
}

/**
 * @param {unknown} value
 * @throws {HoshidictsMiningError}
 */
export function assertHoshidictsBridgePayloadSize(value) {
    let serialized;
    try {
        serialized = JSON.stringify(value);
    } catch {
        throw new HoshidictsMiningError('Invalid Hoshidicts mining payload');
    }
    if (
        typeof serialized !== 'string' ||
        new TextEncoder().encode(serialized).byteLength >
        HOSHIDICTS_MAX_BRIDGE_PAYLOAD_BYTES
    ) {
        throw new HoshidictsMiningError(
            'Hoshidicts mining payload exceeds the 256 KiB limit',
            413,
        );
    }
}

/**
 * @param {unknown} value
 * @returns {{name: string, description: string}}
 * @throws {HoshidictsMiningError}
 */
function validateTraceStep(value) {
    if (!isObjectNotArray(value)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts trace step');
    }
    assertObjectKeys(value, ['name', 'description'], [], 'trace step');
    return {
        name: validateString(value.name, 'trace step name', 1024, false),
        description: validateString(
            value.description,
            'trace step description',
            MAX_TAG_TEXT_LENGTH,
        ),
    };
}

/**
 * @param {unknown} value
 * @returns {{dictionary: string, glossary: string, definitionTags: string, termTags: string}}
 * @throws {HoshidictsMiningError}
 */
function validateGlossary(value) {
    if (!isObjectNotArray(value)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts glossary');
    }
    assertObjectKeys(
        value,
        ['dictionary', 'glossary', 'definitionTags', 'termTags'],
        [],
        'glossary',
    );
    return {
        dictionary: validateString(
            value.dictionary,
            'glossary dictionary',
            MAX_TERM_TEXT_LENGTH,
            false,
        ),
        glossary: validateString(
            value.glossary,
            'glossary content',
            MAX_TEXT_LENGTH,
            false,
        ),
        definitionTags: validateString(
            value.definitionTags,
            'definition tags',
            MAX_TAG_TEXT_LENGTH,
        ),
        termTags: validateString(
            value.termTags,
            'term tags',
            MAX_TAG_TEXT_LENGTH,
        ),
    };
}

/**
 * @param {unknown} value
 * @returns {{
 *   expression: string,
 *   reading: string,
 *   rules: string,
 *   score: number,
 *   glossaries: {dictionary: string, glossary: string, definitionTags: string, termTags: string}[],
 * }}
 * @throws {HoshidictsMiningError}
 */
function validateTerm(value) {
    if (!isObjectNotArray(value)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts term');
    }
    assertObjectKeys(
        value,
        ['expression', 'reading', 'rules', 'score', 'glossaries'],
        [],
        'term',
    );
    if (!Array.isArray(value.glossaries)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts glossaries');
    }
    if (value.glossaries.length > HOSHIDICTS_MAX_GLOSSARIES) {
        throw new HoshidictsMiningError(
            `Hoshidicts mining supports at most ${HOSHIDICTS_MAX_GLOSSARIES} glossaries`,
        );
    }
    if (value.glossaries.length === 0) {
        throw new HoshidictsMiningError('Hoshidicts mining requires a glossary');
    }
    return {
        expression: validateString(
            value.expression,
            'term expression',
            MAX_TERM_TEXT_LENGTH,
            false,
        ),
        reading: validateString(
            value.reading,
            'term reading',
            MAX_TERM_TEXT_LENGTH,
        ),
        rules: validateString(value.rules, 'term rules', MAX_TAG_TEXT_LENGTH),
        score: validateFiniteNumber(value.score, 'term score'),
        glossaries: value.glossaries.map(validateGlossary),
    };
}

/**
 * @param {unknown} value
 * @returns {{
 *   matched: string,
 *   deinflected: string,
 *   preprocessorSteps: number,
 *   trace: {name: string, description: string}[],
 *   term: ReturnType<typeof validateTerm>,
 * }}
 * @throws {HoshidictsMiningError}
 */
function validateResult(value) {
    if (!isObjectNotArray(value)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts term result');
    }
    assertObjectKeys(
        value,
        ['matched', 'deinflected', 'preprocessorSteps', 'trace', 'term'],
        [],
        'term result',
    );
    if (!Array.isArray(value.trace)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts trace');
    }
    if (value.trace.length > HOSHIDICTS_MAX_TRACE_STEPS) {
        throw new HoshidictsMiningError(
            `Hoshidicts mining supports at most ${HOSHIDICTS_MAX_TRACE_STEPS} trace steps`,
        );
    }
    return {
        matched: validateString(
            value.matched,
            'matched text',
            MAX_TERM_TEXT_LENGTH,
            false,
        ),
        deinflected: validateString(
            value.deinflected,
            'deinflected text',
            MAX_TERM_TEXT_LENGTH,
        ),
        preprocessorSteps: validateInteger(
            value.preprocessorSteps,
            'preprocessor step count',
            0,
            HOSHIDICTS_MAX_TRACE_STEPS,
        ),
        trace: value.trace.map(validateTraceStep),
        term: validateTerm(value.term),
    };
}

/**
 * @param {unknown} value
 * @returns {{
 *   operation: 'status'|'mine',
 *   result?: ReturnType<typeof validateResult>,
 *   sentence?: string,
 *   matchOffset?: number,
 * }}
 * @throws {HoshidictsMiningError}
 */
export function validateHoshidictsMiningRequest(value) {
    if (!isObjectNotArray(value)) {
        throw new HoshidictsMiningError('Invalid Hoshidicts mining request');
    }
    const operation = value.operation;
    if (operation === 'status') {
        assertObjectKeys(value, ['operation'], [], 'status request');
        return {operation};
    }
    if (operation !== 'mine') {
        throw new HoshidictsMiningError('Invalid Hoshidicts mining operation');
    }
    assertObjectKeys(
        value,
        ['operation', 'result', 'sentence', 'matchOffset'],
        [],
        'mine request',
    );
    const result = validateResult(value.result);
    const sentence = validateString(
        value.sentence,
        'sentence',
        MAX_TEXT_LENGTH,
        false,
    );
    const matchOffset = validateInteger(
        value.matchOffset,
        'match offset',
        0,
        sentence.length,
    );
    if (!sentence.slice(matchOffset).startsWith(result.matched)) {
        throw new HoshidictsMiningError(
            'The match offset does not point at the matched text',
        );
    }
    return {operation, result, sentence, matchOffset};
}

/**
 * @param {unknown} value
 * @param {string[]} output
 */
function appendGlossaryText(value, output) {
    if (typeof value === 'string') {
        output.push(value);
        return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        output.push(String(value));
        return;
    }
    if (Array.isArray(value)) {
        for (const child of value) {
            appendGlossaryText(child, output);
        }
        return;
    }
    if (!isObjectNotArray(value)) { return; }
    const tag = typeof value.tag === 'string' ? value.tag.toLowerCase() : '';
    if (IGNORED_STRUCTURED_TAGS.has(tag)) { return; }
    if (tag === 'br') {
        output.push('\n');
        return;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'content')) {
        appendGlossaryText(value.content, output);
    } else if (value.type === 'text' && typeof value.text === 'string') {
        output.push(value.text);
    }
    if (BLOCK_STRUCTURED_TAGS.has(tag)) {
        output.push('\n');
    }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

/**
 * @param {string} value
 * @returns {string}
 */
function glossaryToPlainText(value) {
    /** @type {unknown} */
    let parsed = value;
    try {
        parsed = parseJson(value);
    } catch {
        // Plain dictionary strings are used as-is.
    }
    /** @type {string[]} */
    const output = [];
    appendGlossaryText(parsed, output);
    return escapeHtml(
        output.join('')
            .replace(/\n{3,}/gu, '\n\n')
            .trim()
            .slice(0, MAX_TEXT_LENGTH),
    );
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitTags(value) {
    return value.split(/\s+/u).filter((item) => item.length > 0);
}

/**
 * @param {string} name
 * @param {string} category
 * @param {string} dictionary
 * @param {string} [description]
 * @returns {import('dictionary').Tag}
 */
function createTag(name, category, dictionary, description = '') {
    return {
        name,
        category,
        order: 0,
        score: 0,
        content: description.length > 0 ? [description] : [],
        dictionaries: dictionary.length > 0 ? [dictionary] : [],
        redundant: false,
    };
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
    return [...new Set(values.filter(
        (value) => typeof value === 'string' && value.length > 0,
    ))];
}

/**
 * @param {ReturnType<typeof validateResult>} result
 * @param {string} _sentence
 * @param {number} _matchOffset
 * @returns {import('dictionary').TermDictionaryEntry}
 */
export function createHoshidictsDictionaryEntry(
    result,
    _sentence,
    _matchOffset,
) {
    const {
        matched,
        deinflected,
        trace,
        term: {expression, reading, rules, score, glossaries},
    } = result;
    const primaryDictionary = glossaries[0].dictionary;
    const ruleNames = uniqueStrings(splitTags(rules));
    const termTagNames = uniqueStrings([
        ...ruleNames,
        ...glossaries.flatMap(({termTags}) => splitTags(termTags)),
    ]);
    const source = {
        originalText: matched,
        transformedText: matched,
        deinflectedText: deinflected || expression,
        matchType: /** @type {const} */ ('exact'),
        matchSource: /** @type {const} */ ('term'),
        isPrimary: true,
    };
    return {
        type: 'term',
        isPrimary: true,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: trace.length > 0 ?
[{
    source: 'algorithm',
    inflectionRules: trace.map(({name, description}) => ({
        name,
        ...(description.length > 0 ? {description} : {}),
    })),
}] :
[],
        score,
        frequencyOrder: 0,
        dictionaryIndex: 0,
        dictionaryAlias: primaryDictionary,
        sourceTermExactMatchCount: 1,
        matchPrimaryReading: false,
        maxOriginalTextLength: matched.length,
        headwords: [{
            index: 0,
            headwordIndex: 0,
            term: expression,
            reading,
            sources: [source],
            tags: termTagNames.map((name) => createTag(
                name,
                ruleNames.includes(name) ?
                    'partOfSpeech' :
                    'term',
                primaryDictionary,
            )),
            wordClasses: ruleNames,
        }],
        definitions: glossaries.map((glossary, index) => ({
            index,
            headwordIndices: [0],
            dictionary: glossary.dictionary,
            dictionaryIndex: index,
            dictionaryAlias: glossary.dictionary,
            id: index,
            score,
            frequencyOrder: index,
            sequences: [-1],
            isPrimary: true,
            tags: splitTags(glossary.definitionTags).map((name) => createTag(
                name,
                'definition',
                glossary.dictionary,
            )),
            entries: [glossaryToPlainText(glossary.glossary)],
        })),
        pronunciations: [],
        frequencies: [],
    };
}

/**
 * @param {unknown} fields
 * @returns {boolean}
 */
function hasUsableFields(fields) {
    if (!isObjectNotArray(fields)) { return false; }
    const entries = Object.entries(fields);
    return entries.length > 0 && entries.every(([name, field]) => (
        name.length > 0 &&
        isObjectNotArray(field) &&
        typeof field.value === 'string'
    ));
}

/**
 * @param {unknown} cardFormats
 * @returns {{cardFormat: import('settings').AnkiCardFormat, index: number}|null}
 */
export function selectFirstUsableTermCardFormat(cardFormats) {
    if (!Array.isArray(cardFormats)) { return null; }
    for (let index = 0; index < cardFormats.length; ++index) {
        const cardFormat = /** @type {unknown} */ (cardFormats[index]);
        if (
            !isObjectNotArray(cardFormat) ||
            cardFormat.type !== 'term' ||
            typeof cardFormat.deck !== 'string' ||
            cardFormat.deck.trim().length === 0 ||
            typeof cardFormat.model !== 'string' ||
            cardFormat.model.trim().length === 0 ||
            !hasUsableFields(cardFormat.fields)
        ) {
            continue;
        }
        return {
            cardFormat: /** @type {import('settings').AnkiCardFormat} */ (
                cardFormat
            ),
            index,
        };
    }
    return null;
}

export class HoshidictsMining {
    /**
     * @param {HoshidictsMiningApi} api
     * @param {{
     *   ankiNoteBuilder?: Pick<AnkiNoteBuilder, 'createNote'>,
     *   emitNoteAdded?: (noteId: number) => void,
     * }} [options]
     */
    constructor(api, options = {}) {
        /** @type {HoshidictsMiningApi} */
        this._api = api;
        /** @type {Pick<AnkiNoteBuilder, 'createNote'>} */
        this._ankiNoteBuilder = options.ankiNoteBuilder ??
        new AnkiNoteBuilder(api, new TemplateRendererProxy());
        /** @type {(noteId: number) => void} */
        this._emitNoteAdded = options.emitNoteAdded ?? ((noteId) => {
            window.dispatchEvent(new CustomEvent(
                'gsm-anki-note-added',
                {detail: {noteId}},
            ));
        });
        /** @type {?Promise<import('core').SerializableObject>} */
        this._minePromise = null;
    }

    /**
     * @param {unknown} input
     * @returns {Promise<import('core').SerializableObject>}
     * @throws {HoshidictsMiningError}
     */
    async invoke(input) {
        const request = validateHoshidictsMiningRequest(input);
        if (request.operation === 'status') {
            return await this._getStatus();
        }
        if (this._minePromise !== null) {
            throw new HoshidictsMiningError(
                'A Hoshidicts mining operation is already in progress',
                409,
            );
        }
        const promise = this._mine(/** @type {HoshidictsMineRequest} */ (
            request
        ));
        this._minePromise = promise;
        try {
            return await promise;
        } finally {
            this._minePromise = null;
        }
    }

    /**
     * @returns {Promise<import('core').SerializableObject>}
     */
    async _getStatus() {
        try {
            const {cardFormat, cardFormatIndex} =
                await this._getMiningConfiguration();
            return {
                available: true,
                cardFormatIndex,
                cardFormatName: cardFormat.name,
            };
        } catch (e) {
            return {
                available: false,
                error: e instanceof Error ? e.message : String(e),
            };
        }
    }

    /**
     * @returns {Promise<{
     *   options: import('settings').ProfileOptions,
     *   cardFormat: import('settings').AnkiCardFormat,
     *   cardFormatIndex: number,
     * }>}
     * @throws {HoshidictsMiningError}
     */
    async _getMiningConfiguration() {
        const options = await this._api.optionsGet({current: true});
        const anki = options?.anki;
        if (!anki?.enable) {
            throw new HoshidictsMiningError('Anki integration is disabled');
        }
        const selected = selectFirstUsableTermCardFormat(anki.cardFormats);
        if (selected === null) {
            throw new HoshidictsMiningError(
                'No usable active Yomitan term card format is configured',
            );
        }
        if (anki.duplicateBehavior === 'overwrite') {
            throw new HoshidictsMiningError(
                'Overwrite duplicate mode is not supported in Hoshidicts V1',
            );
        }
        if (
            anki.duplicateBehavior !== 'new' &&
            anki.duplicateBehavior !== 'prevent'
        ) {
            throw new HoshidictsMiningError(
                'Unsupported Yomitan duplicate mode',
            );
        }
        if (await this._api.isAnkiConnected() !== true) {
            throw new HoshidictsMiningError('AnkiConnect is unavailable');
        }
        return {
            options,
            cardFormat: selected.cardFormat,
            cardFormatIndex: selected.index,
        };
    }

    /**
     * @param {HoshidictsMineRequest} request
     * @returns {Promise<import('core').SerializableObject>}
     * @throws {HoshidictsMiningError}
     */
    async _mine({result, sentence, matchOffset}) {
        const {options, cardFormat} = await this._getMiningConfiguration();
        const {anki, general} = options;
        let staticTemplates = anki.fieldTemplates;
        if (typeof staticTemplates !== 'string') {
            staticTemplates = await this._api.getDefaultAnkiFieldTemplates();
        }
        const dictionaryInfo = await this._api.getDictionaryInfo();
        const template = staticTemplates + '\n' +
        getDynamicTemplates(options, dictionaryInfo);
        const dictionaryEntry = createHoshidictsDictionaryEntry(
            result,
            sentence,
            matchOffset,
        );
        const tags = uniqueStrings([...anki.tags, 'overlay']);
        const context = {
            url: '',
            sentence: {text: sentence, offset: matchOffset},
            documentTitle: '',
            query: result.matched,
            fullQuery: sentence,
        };
        const {note, errors} = await this._ankiNoteBuilder.createNote({
            dictionaryEntry,
            cardFormat,
            context,
            template,
            tags,
            requirements: [],
            duplicateScope: anki.duplicateScope,
            duplicateScopeCheckAllModels: anki.duplicateScopeCheckAllModels,
            resultOutputMode: general.resultOutputMode,
            glossaryLayoutMode: general.glossaryLayoutMode,
            compactTags: general.compactTags,
            mediaOptions: null,
            dictionaryStylesMap: new Map(),
        });
        if (errors.length > 0) {
            throw new HoshidictsMiningError(
                `Could not render the Anki note: ${errors[0].message}`,
            );
        }

        if (anki.duplicateBehavior === 'prevent') {
            note.options.allowDuplicate = false;
            const [noteInfo] = await this._api.getAnkiNoteInfo([note], false);
            if (!noteInfo?.valid) {
                throw new HoshidictsMiningError(
                    'The configured Yomitan card format produced an invalid note',
                );
            }
            if (
                Array.isArray(noteInfo.noteIds) &&
                noteInfo.noteIds.length > 0
            ) {
                throw new HoshidictsMiningError(
                    'This note already exists and duplicate mode is prevent',
                    409,
                );
            }
        }

        const noteId = await this._api.addAnkiNote(note);
        if (
            typeof noteId !== 'number' ||
            !Number.isSafeInteger(noteId) ||
            noteId <= 0
        ) {
            throw new HoshidictsMiningError('Anki did not return a note ID');
        }

        /** @type {string[]} */
        const warnings = [];
        if (anki.suspendNewCards) {
            try {
                await this._api.suspendAnkiCardsForNote(noteId);
            } catch (e) {
                warnings.push(e instanceof Error ? e.message : String(e));
            }
        }
        if (anki.forceSync) {
            try {
                await this._api.forceSync();
            } catch (e) {
                warnings.push(e instanceof Error ? e.message : String(e));
            }
        }
        try {
            this._emitNoteAdded(noteId);
        } catch (e) {
            warnings.push(e instanceof Error ? e.message : String(e));
        }
        return {success: true, noteId, warnings};
    }
}
