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

import {
    HoshidictsMining,
    HoshidictsMiningError,
    assertHoshidictsBridgePayloadSize,
    isHoshidictsMiningAuthorized,
} from './gsm-hoshidicts-mining.js';

const GSM_YOMITAN_API_REQUEST_EVENT_TYPE = 'gsm-yomitan-api-request';
const GSM_YOMITAN_API_RESPONSE_EVENT_TYPE = 'gsm-yomitan-api-response';
const GSM_HOSHIDICTS_MINING_ACTION = 'hoshidictsMining';

export class GsmYomitanApiBridge {
    /**
     * @param {import('../comm/api.js').API} api
     * @param {{
     *   hoshidictsMining?: Pick<HoshidictsMining, 'invoke'>,
     * }} [options]
     */
    constructor(api, options = {}) {
        /** @type {import('../comm/api.js').API} */
        this._api = api;
        /** @type {?Pick<HoshidictsMining, 'invoke'>} */
        this._hoshidictsMining = options.hoshidictsMining ?? null;
        /** @type {(event: MessageEvent) => void} */
        this._onMessageBind = this._onMessage.bind(this);
    }

    /** */
    prepare() {
        window.addEventListener('message', this._onMessageBind, false);
    }

    /**
     * @param {MessageEvent} event
     */
    _onMessage(event) {
        if (event?.source !== window) { return; }
        const data = /** @type {unknown} */ (event.data);
        if (typeof data !== 'object' || data === null) { return; }
        const dataObject = /** @type {import('core').UnknownObject} */ (data);
        if (dataObject.type !== GSM_YOMITAN_API_REQUEST_EVENT_TYPE) { return; }
        void this._handleRequest(
            dataObject,
            event,
        );
    }

    /**
     * @param {import('core').UnknownObject} data
     * @param {MessageEvent} event
     * @returns {Promise<void>}
     */
    async _handleRequest(data, event) {
        const {requestId} = data;
        if (typeof requestId !== 'number' && typeof requestId !== 'string') {
            return;
        }

        /** @type {{type: string, requestId: number|string, action: string, responseStatusCode: number, data: unknown, error: ?string}} */
        const responseMessage = {
            type: GSM_YOMITAN_API_RESPONSE_EVENT_TYPE,
            requestId,
            action: '',
            responseStatusCode: 500,
            data: null,
            error: null,
        };

        try {
            const action = data.action;
            if (typeof action !== 'string' || action.length === 0) {
                throw new Error('Invalid action');
            }
            responseMessage.action = action;

            if (action === GSM_HOSHIDICTS_MINING_ACTION) {
                if (!isHoshidictsMiningAuthorized(event)) {
                    throw new HoshidictsMiningError(
                        'Hoshidicts mining is restricted to the GSM file overlay',
                        403,
                    );
                }
                assertHoshidictsBridgePayloadSize(data.body);
                this._hoshidictsMining ??= new HoshidictsMining(this._api);
                responseMessage.data = await this._hoshidictsMining.invoke(
                    data.body,
                );
                responseMessage.responseStatusCode = 200;
            } else {
                const result = await this._api.gsmYomitanApiInvoke(
                    action,
                    data.body,
                );
                responseMessage.data = result.data;
                responseMessage.responseStatusCode =
                    Number.isFinite(result.responseStatusCode) ?
                        result.responseStatusCode :
                        500;
            }
        } catch (e) {
            const error = (e instanceof Error) ? e : new Error(String(e));
            responseMessage.error = error.message;
            responseMessage.responseStatusCode =
                error instanceof HoshidictsMiningError ?
                    error.statusCode :
                    500;
        }

        window.postMessage(responseMessage, '*');
    }
}
