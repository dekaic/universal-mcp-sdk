'use strict';

/**
 * protocol/dispatcher.js
 * JSON-RPC 2.0 核心分发器 — 与传输层无关
 */

const { textContent, errorContent } = require('./content');

// Only infer bare content when every block has a known type and its required fields.
function isContentBlock(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    switch (value.type) {
        case 'text': return typeof value.text === 'string';
        case 'image':
        case 'audio': return typeof value.data === 'string' && typeof value.mimeType === 'string';
        case 'resource_link': return typeof value.uri === 'string' && typeof value.name === 'string';
        case 'resource': {
            const resource = value.resource;
            return !!resource && typeof resource === 'object' && !Array.isArray(resource) &&
                typeof resource.uri === 'string' &&
                (typeof resource.text === 'string' || typeof resource.blob === 'string');
        }
        default: return false;
    }
}


const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18'];

// Deliberately limited validation of declared arguments, not a full JSON Schema engine.
function validateArguments(schema, value, at = 'arguments') {
    schema = schema || {};
    const types = { object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
        array: Array.isArray, string: v => typeof v === 'string', boolean: v => typeof v === 'boolean',
        number: v => typeof v === 'number' && Number.isFinite(v), integer: Number.isSafeInteger,
        null: v => v === null };
    if (at === 'arguments' && !types.object(value)) return at + ' must be an object';
    if (schema.type && types[schema.type] && !types[schema.type](value)) return at + ' must be ' + schema.type;
    if (schema.enum && !schema.enum.includes(value)) return at + ' has an invalid value';
    if (schema.const !== undefined && value !== schema.const) return at + ' has an invalid value';
    if (typeof value === 'string' && schema.minLength && value.length < schema.minLength) return at + ' is too short';
    if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) return at + ' is too long';
    if (typeof value === 'number' && (value < schema.minimum || value > schema.maximum)) return at + ' is outside the permitted range';
    if (typeof value === 'number' && (value <= schema.exclusiveMinimum || value >= schema.exclusiveMaximum)) return at + ' is outside the exclusive range';
    if (Array.isArray(value) && (value.length < schema.minItems || value.length > schema.maxItems)) return at + ' has an invalid item count';
    if (schema.oneOf || schema.anyOf) {
        const matches = (schema.oneOf || schema.anyOf).filter(s => !validateArguments(s, value, at));
        if (!matches.length || (schema.oneOf && matches.length !== 1)) return at + ' does not match an allowed shape';
    }
    if (types.object(value)) {
        for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return at + '.' + key + ' is required';
        for (const key of Object.keys(value)) {
            const properties = schema.properties || {};
            if (!Object.hasOwn(properties, key)) {
                if (schema.additionalProperties === false) return at + '.' + key + ' is unknown';
            } else {
                const error = validateArguments(properties[key], value[key], at + '.' + key);
                if (error) return error;
            }
        }
    }
    if (Array.isArray(value) && schema.items) {
        for (let i = 0; i < value.length; i++) {
            const error = validateArguments(schema.items, value[i], at + '[' + i + ']');
            if (error) return error;
        }
    }
    return null;
}

/**
 * 创建 MCP 分发器
 * @param {object} options
 * @param {string} options.name - 服务器名称
 * @param {string} options.version - 服务器版本
 * @param {Array}  options.tools - tool 定义列表
 * @param {Array}  options.resources - resource 定义列表
 * @param {object} [options.customHandlers] - 自定义方法处理器
 */
function createDispatcher(options) {
    const name = options.name || 'unknown';
    const version = options.version || '1.0.0';
    const protocolVersion = options.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    const tools = options.tools || [];
    const resources = options.resources || [];
    const customHandlers = options.customHandlers || {};

    function toToolSchema(tool) {
        const schema = {
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema || { type: 'object', properties: {} },
        };
        if (tool.outputSchema) schema.outputSchema = tool.outputSchema;
        if (tool.annotations) schema.annotations = tool.annotations;
        if (tool._meta) schema._meta = tool._meta;
        if (tool.title) schema.title = tool.title;
        return schema;
    }

    function toResourceSchema(res) {
        return {
            ...Object.fromEntries(Object.entries(res).filter(([key]) => key !== 'read')),
            uri: res.uri,
            name: res.name || res.uri,
            description: res.description || '',
            mimeType: res.mimeType || 'text/plain',
        };
    }

    function wrapContent(result) {
        if (result === undefined || result === null) return [textContent('(ok)')];
        if (typeof result === 'string') return [textContent(result)];
        if (Array.isArray(result) && result.length > 0 && result.every(isContentBlock)) return result;
        if (result && result.text !== undefined && isContentBlock(result)) return [result];
        return [textContent(JSON.stringify(result, null, 2))];
    }

    function normalizeToolResult(result) {
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            const out = {};
            if (result.content !== undefined) out.content = result.content;
            if (result.structuredContent !== undefined) out.structuredContent = result.structuredContent;
            if (result._meta !== undefined) out._meta = result._meta;
            if (result.isError !== undefined) out.isError = result.isError;
            if (Object.keys(out).length > 0) {
                const business = Object.fromEntries(Object.entries(result).filter(([key]) => !['content', 'structuredContent', '_meta', 'isError'].includes(key)));
                if (!out.content) out.content = wrapContent(out.structuredContent || (Object.keys(business).length ? business : '(ok)'));
                // Keep extra fields separate from the declared structured result.
                if ((result.content || result.structuredContent) && Object.keys(business).length) out.content = out.content.concat(wrapContent(business));
                return out;
            }
        }
        return { content: wrapContent(result) };
    }

    function makeErrorResponse(id, message, code = -32603) {
        return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
    }

    function makeSuccessResponse(id, result) {
        if (id === undefined) return null; // notification
        return { jsonrpc: '2.0', id, result };
    }

    function missingRequiredArguments(tool, args) {
        const required = tool.inputSchema && Array.isArray(tool.inputSchema.required)
            ? tool.inputSchema.required
            : [];
        const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        return required.filter((key) => !Object.prototype.hasOwnProperty.call(input, key) || input[key] === undefined);
    }

    function requiredArgumentsMessage(toolName, missing) {
        const label = missing.length === 1 ? 'argument' : 'arguments';
        return `[${toolName}] Missing required ${label}: ${missing.join(', ')}`;
    }

    // ── 同步分发（用于不需要 await 的方法）────────────────────────
    function dispatch(req, context) {
        if (!req || typeof req !== 'object' || Array.isArray(req)) return makeErrorResponse(null, 'Invalid Request', -32600);
        if (req.jsonrpc !== '2.0') {
            return makeErrorResponse(req.id, 'Invalid Request', -32600);
        }
        if (req.method === undefined && req.id !== undefined && ((req.result !== undefined) !== (req.error !== undefined))) return null;
        if (typeof req.method !== 'string' || (req.id !== undefined && typeof req.id !== 'string' && typeof req.id !== 'number') || (req.params !== undefined && (!req.params || typeof req.params !== 'object' || Array.isArray(req.params)))) {
            return makeErrorResponse(req.id, 'Invalid Request', -32600);
        }

        const { method, params, id } = req;

        if (id === undefined && !method.startsWith('notifications/')) return makeErrorResponse(null, 'Requests require an id', -32600);

        switch (method) {
            case 'initialize':
                if (id === undefined || !params || typeof params.protocolVersion !== 'string' || !params.clientInfo || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string' || !params.capabilities || typeof params.capabilities !== 'object' || Array.isArray(params.capabilities)) return makeErrorResponse(id, 'Invalid initialization parameters', -32602);
                return makeSuccessResponse(id, {
                    protocolVersion: params && SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : protocolVersion,
                    capabilities: {
                        tools: tools.length > 0 ? {} : undefined,
                        resources: resources.length > 0 ? {} : undefined,
                    },
                    serverInfo: { name, version },
                });

            case 'initialized':
            case 'notifications/initialized':
                return null; // notification

            case 'ping':
                return makeSuccessResponse(id, {});

            case 'tools/list':
                return makeSuccessResponse(id, {
                    tools: tools.map(t => toToolSchema(t)),
                });

            case 'resources/list':
                return makeSuccessResponse(id, {
                    resources: resources.map(r => toResourceSchema(r)),
                });

            default: {
                if (customHandlers[method]) {
                    try {
                        const result = customHandlers[method](params, { tools, resources, name, version });
                        return makeSuccessResponse(id, result);
                    } catch (e) {
                        return id === undefined ? null : makeErrorResponse(id, e.message);
                    }
                }
                return id === undefined ? null : makeErrorResponse(id, `Method not found: ${method}`, -32601);
            }
        }
    }

    // ── 异步分发（用于 tools/call 和 resources/read，需要 await handler）───
    async function dispatchAsync(req, context) {
        if (!req || typeof req !== 'object' || Array.isArray(req)) return makeErrorResponse(null, 'Invalid Request', -32600);
        if (req.jsonrpc !== '2.0') {
            return makeErrorResponse(req.id, 'Invalid Request', -32600);
        }
        if (req.method === undefined && req.id !== undefined && ((req.result !== undefined) !== (req.error !== undefined))) return null;
        if (typeof req.method !== 'string' || (req.id !== undefined && typeof req.id !== 'string' && typeof req.id !== 'number') || (req.params !== undefined && (!req.params || typeof req.params !== 'object' || Array.isArray(req.params)))) {
            return makeErrorResponse(req.id, 'Invalid Request', -32600);
        }

        const { method, params, id } = req;

        if (id === undefined && !method.startsWith('notifications/')) return makeErrorResponse(null, 'Requests require an id', -32600);

        switch (method) {
            case 'tools/call': {
                if (!params || !params.name) {
                    return makeErrorResponse(id, 'Missing tool name', -32602);
                }
                const tool = tools.find(t => t.name === params.name);
                if (!tool) {
                    return makeErrorResponse(id, `Tool not found: ${params.name}`, -32602);
                }
                const missing = missingRequiredArguments(tool, params.arguments);
                if (missing.length > 0) {
                    return makeErrorResponse(id, requiredArgumentsMessage(params.name, missing), -32602);
                }
                const argumentError = validateArguments(tool.inputSchema, params.arguments === undefined ? {} : params.arguments);
                if (argumentError) return makeErrorResponse(id, '[' + params.name + '] ' + argumentError, -32602);
                try {
                    const result = await tool.handler(params.arguments || {}, { ...(context || {}), requestMeta: params._meta });
                    return makeSuccessResponse(id, normalizeToolResult(result));
                } catch (e) {
                    return makeSuccessResponse(id, {
                        content: [errorContent(`[${params.name}] Error: ${e.message}`)],
                        isError: true,
                    });
                }
            }

            case 'resources/read': {
                if (!params || typeof params.uri !== 'string' || !params.uri) {
                    return makeErrorResponse(id, 'Missing resource uri', -32602);
                }
                const res = resources.find(r => r.uri === params.uri);
                if (!res) {
                    return makeErrorResponse(id, `Resource not found: ${params.uri}`, -32002);
                }
                try {
                    const data = await res.read();
                    const mimeType = res.mimeType || 'text/plain';
                    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
                    return makeSuccessResponse(id, { contents: [{ uri: res.uri, text, mimeType }] });
                } catch (e) {
                    return makeErrorResponse(id, `[${params.uri}] Error: ${e.message}`, -32603);
                }
            }

            case 'initialized':
            case 'notifications/initialized':
                return null; // notification

            default:
                return dispatch(req, context);
        }
    }

    return { dispatch, dispatchAsync };
}

module.exports = { createDispatcher, validateArguments };
