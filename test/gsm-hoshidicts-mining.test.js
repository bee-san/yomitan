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

import fs from 'node:fs/promises';
import {describe, expect, test, vi} from 'vitest';
import {AnkiNoteBuilder} from '../ext/js/data/anki-note-builder.js';
import {
    HoshidictsMining,
    assertHoshidictsBridgePayloadSize,
    createHoshidictsDictionaryEntry,
    isHoshidictsMiningAuthorized,
    selectFirstUsableTermCardFormat,
    validateHoshidictsMiningRequest,
} from '../ext/js/app/gsm-hoshidicts-mining.js';
import {GsmYomitanApiBridge} from '../ext/js/app/gsm-yomitan-api-bridge.js';
import {createAnkiTemplateRendererTest} from './fixtures/anki-template-renderer-test.js';

const rendererTest = await createAnkiTemplateRendererTest();
const DEFAULT_TEMPLATE = await fs.readFile(
    new URL('../ext/data/templates/default-anki-field-templates.handlebars', import.meta.url),
    'utf8',
);

/**
 * @param {string} [name]
 * @returns {import('settings').AnkiCardFormat}
 */
function createCardFormat(name = 'Mining') {
    return {
        type: 'term',
        name,
        deck: 'Mining',
        model: 'Basic',
        fields: {
            Expression: {value: '{expression}', overwriteMode: 'coalesce'},
            Reading: {value: '{reading}', overwriteMode: 'coalesce'},
        },
        icon: 'big-circle',
    };
}

/**
 * @param {{anki?: Partial<import('settings').AnkiOptions>}} [overrides]
 * @returns {import('settings').ProfileOptions}
 */
function createOptions(overrides = {}) {
    const ankiOverrides = overrides.anki ?? {};
    return /** @type {import('settings').ProfileOptions} */ (
        /** @type {unknown} */ ({
            general: {
                resultOutputMode: 'split',
                glossaryLayoutMode: 'default',
                compactTags: false,
            },
            dictionaries: [],
            anki: {
                enable: true,
                tags: ['profile-tag'],
                cardFormats: [createCardFormat()],
                duplicateScope: 'collection',
                duplicateScopeCheckAllModels: false,
                duplicateBehavior: 'new',
                fieldTemplates: DEFAULT_TEMPLATE,
                suspendNewCards: false,
                forceSync: false,
                ...ankiOverrides,
            },
        })
    );
}

/**
 * @returns {{
 *   operation: string,
 *   sentence: string,
 *   matchOffset: number,
 *   result: {
 *     matched: string,
 *     deinflected: string,
 *     preprocessorSteps: number,
 *     trace: {name: string, description: string}[],
 *     term: {
 *       expression: string,
 *       reading: string,
 *       rules: string,
 *       score: number,
 *       glossaries: {
 *         dictionary: string,
 *         glossary: string,
 *         definitionTags: string,
 *         termTags: string,
 *       }[],
 *     },
 *   },
 * }}
 */
function createMineRequest() {
    return {
        operation: 'mine',
        sentence: '昨日、食べた。',
        matchOffset: 3,
        result: {
            matched: '食べた',
            deinflected: '食べる',
            preprocessorSteps: 0,
            trace: [
                {name: 'past', description: 'Past tense'},
            ],
            term: {
                expression: '食べる',
                reading: 'たべる',
                rules: 'v1',
                score: 10,
                glossaries: [
                    {
                        dictionary: 'JMdict',
                        glossary: 'to eat',
                        definitionTags: 'common',
                        termTags: 'uk',
                    },
                    {
                        dictionary: 'JMdict',
                        glossary: JSON.stringify({
                            tag: 'span',
                            content: [
                                {tag: 'strong', content: 'consume'},
                                {tag: 'img', path: 'ignored.png'},
                            ],
                        }),
                        definitionTags: '',
                        termTags: '',
                    },
                ],
            },
        },
    };
}

/**
 * @param {import('settings').ProfileOptions} options
 * @param {Partial<import('../ext/js/comm/api.js').API>} [overrides]
 * @returns {import('../ext/js/comm/api.js').API}
 */
function createApi(options, overrides = {}) {
    return /** @type {import('../ext/js/comm/api.js').API} */ ({
        optionsGet: vi.fn(async () => options),
        isAnkiConnected: vi.fn(async () => true),
        getDefaultAnkiFieldTemplates: vi.fn(async () => DEFAULT_TEMPLATE),
        getDictionaryInfo: vi.fn(async () => []),
        getAnkiNoteInfo: vi.fn(async () => [{
            canAdd: true,
            valid: true,
            noteIds: null,
        }]),
        addAnkiNote: vi.fn(async () => 42),
        suspendAnkiCardsForNote: vi.fn(async () => {}),
        forceSync: vi.fn(async () => {}),
        injectAnkiNoteMedia: vi.fn(async () => ({
            audioFileName: null,
            screenshotFileName: null,
            clipboardImageFileName: null,
            clipboardText: null,
            dictionaryMedia: [],
            errors: [],
        })),
        parseText: vi.fn(async () => []),
        ...overrides,
    });
}

/**
 * @returns {Pick<AnkiNoteBuilder, 'createNote'>}
 */
function createFakeNoteBuilder() {
    const createNote = vi.fn(async (
        /** @type {import('anki-note-builder').CreateNoteDetails} */
        {cardFormat, tags},
    ) => ({
        note: {
            fields: {Expression: '食べる'},
            tags,
            deckName: cardFormat.deck,
            modelName: cardFormat.model,
            options: {
                allowDuplicate: true,
                duplicateScope: 'collection',
                duplicateScopeOptions: {
                    deckName: null,
                    checkChildren: false,
                    checkAllModels: false,
                },
            },
        },
        errors: [],
        requirements: [],
    }));
    return /** @type {Pick<AnkiNoteBuilder, 'createNote'>} */ ({
        createNote,
    });
}

/**
 * @param {string} pathname
 * @param {unknown} body
 * @returns {Promise<{
 *   invoke: ReturnType<typeof vi.fn>,
 *   response: import('core').UnknownObject,
 * }>}
 */
async function sendBridgeRequest(pathname, body) {
    /** @type {((event: MessageEvent) => void)[]} */
    const messageListeners = [];
    /**
     * @param {string} type
     * @param {EventListenerOrEventListenerObject} listener
     */
    function addEventListener(type, listener) {
        if (type === 'message' && typeof listener === 'function') {
            messageListeners.push(
                /** @type {(event: MessageEvent) => void} */ (
                    /** @type {unknown} */ (listener)
                ),
            );
        }
    }
    const postMessage = vi.fn((
        /** @type {unknown} */ _message,
        /** @type {string} */ _targetOrigin,
    ) => {});
    const windowValue = {
        location: {protocol: 'file:', pathname},
        addEventListener,
        postMessage,
        top: /** @type {unknown} */ (null),
    };
    windowValue.top = windowValue;
    const windowRef =
        /** @type {Window} */ (/** @type {unknown} */ (windowValue));
    const documentRef = /** @type {Document} */ (/** @type {unknown} */ ({
        documentElement: {dataset: {gsmHoshidictsEnabled: 'true'}},
    }));
    vi.stubGlobal('window', windowRef);
    vi.stubGlobal('document', documentRef);

    const invoke = vi.fn(async () => ({available: true}));
    const bridge = new GsmYomitanApiBridge(
        /** @type {import('../ext/js/comm/api.js').API} */ ({}),
        {hoshidictsMining: {invoke}},
    );
    bridge.prepare();
    const messageListener = messageListeners[0];
    if (typeof messageListener !== 'function') {
        throw new Error('Bridge did not register a message listener');
    }
    messageListener(/** @type {MessageEvent} */ (/** @type {unknown} */ ({
        data: {
            type: 'gsm-yomitan-api-request',
            requestId: 'request-1',
            action: 'hoshidictsMining',
            body,
        },
        source: windowRef,
    })));
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
    const response = /** @type {unknown} */ (postMessage.mock.calls[0][0]);
    if (
        typeof response !== 'object' ||
        response === null ||
        Array.isArray(response)
    ) {
        throw new Error('Bridge returned an invalid response');
    }
    vi.unstubAllGlobals();
    return {
        invoke,
        response: /** @type {import('core').UnknownObject} */ (response),
    };
}

describe('Hoshidicts mining authorization and validation', () => {
    test('authorizes only the top-level marked GSM file overlay', () => {
        const windowValue = {
            location: {protocol: 'file:', pathname: '/GSM/GSM_Overlay/index.html'},
            top: /** @type {unknown} */ (null),
        };
        windowValue.top = windowValue;
        const windowRef =
            /** @type {Window} */ (/** @type {unknown} */ (windowValue));
        const documentRef = /** @type {Document} */ (/** @type {unknown} */ ({
            documentElement: {dataset: {gsmHoshidictsEnabled: 'true'}},
        }));

        expect(isHoshidictsMiningAuthorized(
            {source: windowRef},
            windowRef,
            documentRef,
        )).toBe(true);
        expect(isHoshidictsMiningAuthorized(
            {source: {}},
            windowRef,
            documentRef,
        )).toBe(false);
        expect(isHoshidictsMiningAuthorized(
            {source: windowRef},
            /** @type {Window} */ (/** @type {unknown} */ ({
                ...windowRef,
                location: {protocol: 'https:', pathname: '/index.html'},
            })),
            documentRef,
        )).toBe(false);
        expect(isHoshidictsMiningAuthorized(
            {source: windowRef},
            windowRef,
            /** @type {Document} */ (/** @type {unknown} */ ({
                documentElement: {dataset: {}},
            })),
        )).toBe(false);
    });

    test('bridge rejects a marked file page outside GSM_Overlay', async () => {
        const {invoke, response} = await sendBridgeRequest(
            '/other/index.html',
            {operation: 'status'},
        );

        expect(invoke).not.toHaveBeenCalled();
        expect(response.requestId).toBe('request-1');
        expect(response.responseStatusCode).toBe(403);
        expect(response.error).toMatch(/restricted/u);
    });

    test('bridge reports an oversized payload without invoking mining', async () => {
        const {invoke, response} = await sendBridgeRequest(
            '/home/user/GSM_Overlay/index.html',
            {operation: 'mine', padding: 'x'.repeat(256 * 1024)},
        );

        expect(invoke).not.toHaveBeenCalled();
        expect(response.requestId).toBe('request-1');
        expect(response.responseStatusCode).toBe(413);
        expect(response.error).toMatch(/256 KiB/u);
    });

    test('enforces the 256 KiB bridge payload limit', () => {
        expect(() => assertHoshidictsBridgePayloadSize({
            operation: 'mine',
            padding: 'x'.repeat(256 * 1024),
        })).toThrow(/256 KiB/u);
        expect(() => assertHoshidictsBridgePayloadSize({
            operation: 'status',
        })).not.toThrow();
    });

    test('caps glossaries and deinflection trace steps', () => {
        const tooManyGlossaries = createMineRequest();
        tooManyGlossaries.result.term.glossaries = Array.from(
            {length: 65},
            () => ({...tooManyGlossaries.result.term.glossaries[0]}),
        );
        expect(() => validateHoshidictsMiningRequest(tooManyGlossaries))
            .toThrow(/64 glossaries/u);

        const tooManyTraceSteps = createMineRequest();
        tooManyTraceSteps.result.trace = Array.from(
            {length: 33},
            () => ({name: 'step', description: ''}),
        );
        expect(() => validateHoshidictsMiningRequest(tooManyTraceSteps))
            .toThrow(/32 trace steps/u);
    });

    test('rejects an offset that does not point at the matched text', () => {
        const request = createMineRequest();
        request.matchOffset = 0;
        expect(() => validateHoshidictsMiningRequest(request))
            .toThrow(/match offset/u);
    });
});

describe('Hoshidicts term conversion', () => {
    test('selects only the first usable active term card format', () => {
        const usable = createCardFormat('First usable');
        const result = selectFirstUsableTermCardFormat([
            {...createCardFormat('Kanji'), type: 'kanji'},
            {...createCardFormat('No deck'), deck: ''},
            usable,
            createCardFormat('Second usable'),
        ]);

        expect(result).toEqual({cardFormat: usable, index: 2});
    });

    test('creates a minimal text-only term entry', () => {
        const request = validateHoshidictsMiningRequest(
            createMineRequest(),
        );
        if (
            request.operation !== 'mine' ||
            typeof request.result === 'undefined' ||
            typeof request.sentence === 'undefined' ||
            typeof request.matchOffset === 'undefined'
        ) {
            throw new Error('Expected a validated mine request');
        }
        const dictionaryEntry = createHoshidictsDictionaryEntry(
            request.result,
            request.sentence,
            request.matchOffset,
        );

        expect(dictionaryEntry.headwords[0]).toMatchObject({
            term: '食べる',
            reading: 'たべる',
            wordClasses: ['v1'],
        });
        expect(dictionaryEntry.definitions).toHaveLength(2);
        expect(dictionaryEntry.definitions[1].entries).toEqual(['consume']);
        expect(dictionaryEntry.frequencies).toEqual([]);
        expect(dictionaryEntry.pronunciations).toEqual([]);
        expect(dictionaryEntry.inflectionRuleChainCandidates[0].inflectionRules)
            .toEqual([{name: 'past', description: 'Past tense'}]);
    });
});

describe('Hoshidicts Anki integration', () => {
    test('reports availability and the first usable format', async () => {
        const options = createOptions({
            anki: {
                cardFormats: [
                    {...createCardFormat('Invalid'), deck: ''},
                    createCardFormat('Usable'),
                ],
            },
        });
        const api = createApi(options);
        const mining = new HoshidictsMining(api, {
            ankiNoteBuilder: createFakeNoteBuilder(),
        });

        await expect(mining.invoke({operation: 'status'})).resolves.toEqual({
            available: true,
            cardFormatIndex: 1,
            cardFormatName: 'Usable',
        });
    });

    rendererTest('renders supported fields and adds exactly one note', async ({
        ankiTemplateRenderer,
    }) => {
        const options = createOptions({
            anki: {
                tags: ['profile-tag', 'overlay', 'profile-tag'],
                cardFormats: [{
                    ...createCardFormat(),
                    fields: {
                        Expression: {value: '{expression}', overwriteMode: 'coalesce'},
                        Reading: {value: '{reading}', overwriteMode: 'coalesce'},
                        Furigana: {value: '{furigana}', overwriteMode: 'coalesce'},
                        Glossary: {value: '{glossary-plain}', overwriteMode: 'coalesce'},
                        Dictionary: {value: '{dictionary}', overwriteMode: 'coalesce'},
                        Tags: {value: '{tags}', overwriteMode: 'coalesce'},
                        Sentence: {value: '{sentence}', overwriteMode: 'coalesce'},
                        Cloze: {value: '{cloze-body}', overwriteMode: 'coalesce'},
                        Frequency: {value: '{frequencies}', overwriteMode: 'coalesce'},
                        Pitch: {value: '{pitch-accents}', overwriteMode: 'coalesce'},
                        Audio: {value: '{audio}', overwriteMode: 'coalesce'},
                        Screenshot: {value: '{screenshot}', overwriteMode: 'coalesce'},
                    },
                }],
                suspendNewCards: true,
                forceSync: true,
            },
        });
        /** @type {import('anki').Note[]} */
        const addedNotes = [];
        const addAnkiNote = vi.fn(async (
            /** @type {import('anki').Note} */ note,
        ) => {
            addedNotes.push(note);
            return 42;
        });
        const suspendAnkiCardsForNote = vi.fn(async (
            /** @type {number} */ _noteId,
        ) => 1);
        const forceSync = vi.fn(async () => {});
        const api = createApi(options, {
            addAnkiNote,
            suspendAnkiCardsForNote,
            forceSync,
        });
        const emitNoteAdded = vi.fn();
        const noteBuilder = new AnkiNoteBuilder(
            api,
            ankiTemplateRenderer.templateRenderer,
        );
        const mining = new HoshidictsMining(api, {
            ankiNoteBuilder: noteBuilder,
            emitNoteAdded,
        });

        await expect(mining.invoke(createMineRequest())).resolves.toEqual({
            success: true,
            noteId: 42,
            warnings: [],
        });

        expect(addAnkiNote).toHaveBeenCalledOnce();
        const note = addedNotes[0];
        if (!note) {
            throw new Error('Expected one added note');
        }
        expect(note.tags).toEqual(['profile-tag', 'overlay']);
        expect(note.fields.Expression).toBe('食べる');
        expect(note.fields.Reading).toBe('たべる');
        expect(note.fields.Furigana).toContain('食');
        expect(note.fields.Glossary).toContain('to eat');
        expect(note.fields.Glossary).toContain('consume');
        expect(note.fields.Dictionary).toBe('JMdict');
        expect(note.fields.Tags).toMatch(/v1|uk/u);
        expect(note.fields.Sentence).toBe('昨日、食べた。');
        expect(note.fields.Cloze).toBe('食べた');
        expect(note.fields.Frequency).toBe('');
        expect(note.fields.Pitch).toBe('');
        expect(note.fields.Audio).toBe('');
        expect(note.fields.Screenshot).toBe('');
        expect(suspendAnkiCardsForNote).toHaveBeenCalledExactlyOnceWith(42);
        expect(forceSync).toHaveBeenCalledOnce();
        expect(emitNoteAdded).toHaveBeenCalledExactlyOnceWith(42);
    });

    test('prevents duplicates without calling addNote', async () => {
        const options = createOptions({
            anki: {duplicateBehavior: 'prevent'},
        });
        const addAnkiNote = vi.fn(async (
            /** @type {import('anki').Note} */ _note,
        ) => 42);
        const api = createApi(options, {
            addAnkiNote,
            getAnkiNoteInfo: vi.fn(async () => [{
                canAdd: true,
                valid: true,
                noteIds: [7],
            }]),
        });
        const mining = new HoshidictsMining(api, {
            ankiNoteBuilder: createFakeNoteBuilder(),
        });

        await expect(mining.invoke(createMineRequest()))
            .rejects.toThrow(/duplicate mode is prevent/u);
        expect(addAnkiNote).not.toHaveBeenCalled();
    });

    test('rejects overwrite mode with a clear V1 error', async () => {
        const options = createOptions({
            anki: {duplicateBehavior: 'overwrite'},
        });
        const addAnkiNote = vi.fn(async (
            /** @type {import('anki').Note} */ _note,
        ) => 42);
        const api = createApi(options, {addAnkiNote});
        const mining = new HoshidictsMining(api, {
            ankiNoteBuilder: createFakeNoteBuilder(),
        });

        await expect(mining.invoke(createMineRequest()))
            .rejects.toThrow(/Overwrite duplicate mode is not supported in Hoshidicts V1/u);
        expect(addAnkiNote).not.toHaveBeenCalled();
    });
});
